/**
 * Deterministic Wayback Machine (CDX) archive pass.
 *
 * Current profile state hides pre-rename history: a handle that was renamed
 * or reclaimed shows only its present owner, and search engines index only
 * the present. The Internet Archive's CDX API is the independent memory —
 * querying it for `<platform>/<handle>` profile URLs answers questions no
 * live page can:
 *
 *   - Was this handle registered YEARS before the current account? (an
 *     archived first snapshot that PREDATES the subject's Reddit cake day is
 *     the pre-rename / defunct-profile gold)
 *   - Did a platform profile exist at all for a handle that now 404s?
 *   - How long has the handle been in continuous use (span + count)?
 *
 * Runs on the web sweep's top handles (bridge owners / cluster handles).
 * Deliberately queries EXACT profile URLs (no matchType=prefix): a prefix
 * query would drown in the platform's every page; we only want the profile
 * root's capture history.
 *
 * All I/O goes through one DI seam (`opts.deps.fetchJson`); tests inject
 * fakes and never touch the network. Per-query errors are swallowed — the
 * Wayback API is famously flaky and must never abort a run. Snapshots are
 * LEADS: an archived capture may predate a rename or reclaim, so the handle
 * in an old snapshot may have belonged to someone else entirely.
 */

export interface ArchiveSnapshot {
  /** Canonical CDX URL key (e.g. "twitter.com/handle/"). */
  url: string;
  /** First 200-status capture, YYYYMMDDhhmmss CDX stamp (UTC). */
  firstSnapshot: string;
  /** Last 200-status capture, YYYYMMDDhhmmss CDX stamp (UTC). */
  lastSnapshot: string;
  /** Number of 200-status captures observed for this URL. */
  count: number;
}

export interface ArchivePassResult {
  snapshots: ArchiveSnapshot[];
}

/** Profile-URL patterns worth archive lookups. Ordered highest-signal first
 *  (x/twitter first: rename churn is highest there and captures are dense). */
function profilePatterns(handle: string): string[] {
  return [
    `x.com/${handle}`,
    `twitter.com/${handle}`,
    `instagram.com/${handle}`,
    `github.com/${handle}`,
    `t.me/${handle}`,
  ];
}

/** DI seam for the CDX HTTP GET (returns parsed JSON). */
export interface ArchivePassDeps {
  fetchJson?: (url: string) => Promise<any>;
}

const CDX_ENDPOINT = "http://web.archive.org/cdx/search/cdx";
/** NOTE: deliberately NO `collapse=urlkey`. With an exact-URL query every
 *  capture of the URL shares one urlkey, so collapse=urlkey would return a
 *  SINGLE row and destroy the first/last/count span this pass exists to
 *  compute. Collapse is only meaningful for prefix/domain queries. */
function cdxUrl(pattern: string): string {
  return `${CDX_ENDPOINT}?url=${encodeURIComponent(pattern)}&output=json&limit=50`;
}

const UA = "osint-ai/2.0 (research; archive pass)";
const TIMEOUT_MS = 10_000;
const POLITE_DELAY_MS = 250;
const MAX_HANDLES_DEFAULT = 2;

/** Real-network fetchJson: 10s hard timeout, never throws (null on failure —
 *  swallowed upstream as "no snapshots for this query"). */
async function defaultFetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** CDX JSON is an array of arrays: row 0 is the header
 *  ["url","timestamp","original","mimetype","statuscode","digest","length"].
 *  Be defensive about shape (the API sometimes returns objects or empty
 *  bodies); only well-formed rows survive. */
function parseCdxRows(json: any): string[][] {
  if (!Array.isArray(json)) return [];
  return json.filter((row) => Array.isArray(row) && row.length >= 5 && typeof row[0] === "string");
}

/** Merge one CDX response into the by-URL snapshot map. Keeps only
 *  statuscode==="200" captures (3xx/4xx/5xx captures are error pages the
 *  archive saved, not the profile). Timestamps are YYYYMMDDhhmmss UTC, so
 *  plain string comparison orders them correctly. */
function mergeRows(json: any, into: Map<string, ArchiveSnapshot>): void {
  const rows = parseCdxRows(json).slice(1); // drop the header row
  for (const row of rows) {
    const [url, timestamp, , , statuscode] = row;
    if (statuscode !== "200" || !/^\d{14}$/.test(timestamp)) continue;
    const existing = into.get(url);
    if (existing) {
      existing.firstSnapshot = existing.firstSnapshot < timestamp ? existing.firstSnapshot : timestamp;
      existing.lastSnapshot = existing.lastSnapshot > timestamp ? existing.lastSnapshot : timestamp;
      existing.count += 1;
    } else {
      into.set(url, { url, firstSnapshot: timestamp, lastSnapshot: timestamp, count: 1 });
    }
  }
}

/**
 * Query the Wayback CDX API for each handle's profile-URL patterns.
 * `subjectCreatedUtc` (unix seconds — the subject's Reddit cake day) is NOT
 * used here; it annotates in the renderers, flagging snapshots whose first
 * capture predates the account: possible pre-rename or defunct profiles.
 */
export async function runArchivePass(
  handles: string[],
  opts: {
    maxHandles?: number;
    subjectCreatedUtc?: number;
    deps?: ArchivePassDeps;
  } = {},
  onProgress?: (msg: string) => void,
): Promise<ArchivePassResult> {
  const maxHandles = opts.maxHandles ?? MAX_HANDLES_DEFAULT;
  const injected = opts.deps?.fetchJson;
  const fetchJson = injected ?? defaultFetchJson;

  const seen = new Map<string, string>();
  for (const raw of handles) {
    const h = raw.replace(/^@/, "").trim();
    if (h.length < 2) continue;
    const key = h.toLowerCase();
    if (!seen.has(key)) seen.set(key, h);
  }
  const archiveHandles = [...seen.values()].slice(0, maxHandles);

  onProgress?.(
    `[archive-pass] Querying Wayback CDX for ${archiveHandles.length} handle(s) × ${profilePatterns("x").length} platforms...`,
  );

  const byUrl = new Map<string, ArchiveSnapshot>();
  for (const handle of archiveHandles) {
    for (const pattern of profilePatterns(handle)) {
      // Per-query resilience: the CDX API wobbles constantly — a failed
      // query just means "no data for this URL", never an abort.
      try {
        const json = await fetchJson(cdxUrl(pattern));
        mergeRows(json, byUrl);
      } catch {
        // swallowed: this pattern contributes nothing
      }
      // Politeness only on the real network path — injected fakes (tests)
      // run instantly.
      if (!injected) await sleep(POLITE_DELAY_MS);
    }
  }

  const snapshots = [...byUrl.values()];
  onProgress?.(
    `[archive-pass] Done: ${snapshots.length} archived profile URL(s) with 200-status captures.`,
  );
  return { snapshots };
}

/** YYYYMMDDhhmmss CDX stamp → unix ms (UTC), for cake-day comparison. */
function stampToMs(stamp: string): number {
  const y = +stamp.slice(0, 4), mo = +stamp.slice(4, 6), d = +stamp.slice(6, 8);
  const h = +stamp.slice(8, 10), mi = +stamp.slice(10, 12), s = +stamp.slice(12, 14);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** YYYYMMDDhhmmss → "YYYY-MM-DD" for display. */
function stampToDate(stamp: string): string {
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
}

/** True when the snapshot's FIRST capture predates the subject's Reddit
 *  cake day — the pre-rename / defunct-profile signal. */
function predatesCakeDay(snap: ArchiveSnapshot, subjectCreatedUtc?: number): boolean {
  if (subjectCreatedUtc === undefined) return false;
  return stampToMs(snap.firstSnapshot) < subjectCreatedUtc * 1000;
}

/** Report block: per-URL first→last span + capture count, with the
 *  pre-cake-day marker and the lead-not-evidence caveat. "" when empty. */
export function renderArchiveBlock(result: ArchivePassResult, subjectCreatedUtc?: number): string {
  if (result.snapshots.length === 0) return "";
  const lines: string[] = [
    "## Web Archive Pass",
    "",
    "Wayback Machine (CDX) lookups of profile URLs for the top handles. An",
    "archived snapshot is a LEAD, not evidence — the handle may have belonged",
    "to someone else before a rename or reclaim.",
    "",
  ];
  for (const snap of result.snapshots) {
    lines.push(
      `- ${snap.url}: ${stampToDate(snap.firstSnapshot)} → ${stampToDate(snap.lastSnapshot)} (${snap.count} snapshot${snap.count === 1 ? "" : "s"})`,
    );
    if (predatesCakeDay(snap, subjectCreatedUtc)) {
      lines.push(
        "  - ⚠ first capture EXISTED BEFORE the subject's Reddit account — possible pre-rename/defunct profile",
      );
    }
  }
  return lines.join("\n");
}

/** Compact ground-truth-style prompt injection: every archived profile URL
 *  as a lead, with the pre-cake-day flag where it applies. "" when empty. */
export function renderArchiveContextForPrompt(
  result: ArchivePassResult,
  subjectCreatedUtc?: number,
): string {
  if (result.snapshots.length === 0) return "";
  const lines = [
    "WAYBACK ARCHIVE LEADS (deterministic CDX lookups; leads, not identity evidence — an old snapshot may predate a rename/reclaim and belong to someone else):",
  ];
  for (const snap of result.snapshots) {
    const flag = predatesCakeDay(snap, subjectCreatedUtc)
      ? " [first capture PREDATES the subject's Reddit account — possible pre-rename/defunct profile]"
      : "";
    lines.push(
      `- archived snapshots of ${snap.url}: first ${stampToDate(snap.firstSnapshot)}, last ${stampToDate(snap.lastSnapshot)}, ${snap.count} capture(s)${flag}`,
    );
  }
  return lines.join("\n");
}
