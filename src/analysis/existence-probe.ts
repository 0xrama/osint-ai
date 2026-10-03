/**
 * Deterministic username-existence probes (sherlock-style).
 *
 * Search engines never index most profile pages, so the web sweep only sees
 * handles that something *links to*. This pass closes that gap the cheap way:
 * for the sweep's top-tier handles (bridge owners / cluster handles — the
 * likely CURRENT identities), plain unauthenticated GETs of
 * `platform/<handle>` across a curated site list. A page that 200s (or carries
 * the platform's "profile exists" marker) proves the handle is REGISTERED
 * there — a deterministic lead the synthesis agent gets as ground truth.
 *
 * Design choices:
 *   - Existence ≠ same person. Every hit is a LEAD; the renderer and the
 *     prompt context both frame it that way so the LLM verifies instead of
 *     assuming.
 *   - Conservative classification: anything ambiguous (redirects, auth walls,
 *     marker misses, network errors) is "unknown" — never a false "absent"
 *     that could suppress a real lead, never a false "exists" from a login
 *     page that happens to 200.
 *   - Redirects are NOT followed (`redirect: "manual"`): login-wall redirects
 *     (x.com-style) would otherwise land on a 200 login page and read as
 *     "exists". Any 3xx classifies unknown.
 *   - Marker sites read only the first ~4KB of the body: the distinguishing
 *     text sits early in the HTML, and pulling whole pages for 25 targets ×
 *     several handles is waste.
 *
 * All I/O goes through a single DI seam (`opts.deps.fetchText`); tests inject
 * fakes and never touch the network. Per-probe errors are swallowed →
 * "unknown": one flaky site must never abort the pass.
 */

export type ProbeOutcome = "exists" | "absent" | "unknown";

/** One curated probe target. Only sites where a plain unauthenticated GET
 *  distinguishes existence belong here; walled gardens and JS shells are
 *  excluded below with reasons. */
interface ProbeTarget {
  platform: string;
  urlFor: (handle: string) => string;
  /** "status": HTTP status alone decides (200 → exists, 404/410 → absent).
   *  "status+marker": additionally test `marker` against the first ~4KB of
   *  the body (case-insensitive) — needed where the platform 200s both
   *  existing and missing profile pages. */
  detect: "status" | "status+marker";
  marker?: RegExp;
  /** Polarity of `marker` (default "present").
   *  "present": the marker text appears on EXISTING profiles → match means
   *  exists, miss on a 200 is unknown (layout drift must not fake "absent").
   *  "absent": the marker text appears on MISSING-profile pages → match
   *  means absent, miss on a 200 means exists (the site 200s everything;
   *  only the not-found text distinguishes). */
  markerSemantics?: "present" | "absent";
}

/**
 * The curated site list. Detection behavior marked "unverified" was chosen
 * for plausibility, not confirmed against the live site — those entries may
 * classify as "unknown" in practice, which is safe.
 *
 * EXCLUDED — walled gardens where a plain GET always 200s or always
 * redirects to login (existence is not distinguishable without auth, and a
 * login page would masquerade as a profile): x.com / twitter.com,
 * instagram.com, facebook.com, linkedin.com, tiktok.com. These are covered
 * by the web sweep (search snippets) and the twitter pass (API reads).
 * EXCLUDED — JS SPA shells where the server 200s an app shell for ANY
 * handle (existence never reaches the HTTP layer): bsky.app (use the
 * Bluesky AppView API instead — different pass), kick.com.
 */
const PROBE_TARGETS: ProbeTarget[] = [
  // --- Developer platforms (best fit for this tool's usual subjects) ---
  { platform: "gitlab", urlFor: (h) => `https://gitlab.com/${h}`, detect: "status" },
  { platform: "dev.to", urlFor: (h) => `https://dev.to/${h}`, detect: "status" },
  { platform: "medium", urlFor: (h) => `https://medium.com/@${h}`, detect: "status" },
  { platform: "npm", urlFor: (h) => `https://www.npmjs.com/~${h}`, detect: "status" },
  { platform: "hackerrank", urlFor: (h) => `https://www.hackerrank.com/profile/${h}`, detect: "status" }, // unverified
  { platform: "codeforces", urlFor: (h) => `https://codeforces.com/profile/${h}`, detect: "status" }, // unverified
  { platform: "hackthebox", urlFor: (h) => `https://app.hackthebox.com/users/${h}`, detect: "status" }, // unverified
  { platform: "tryhackme", urlFor: (h) => `https://tryhackme.com/p/${h}`, detect: "status" },
  // --- Social / messaging ---
  { platform: "telegram", urlFor: (h) => `https://t.me/${h}`, detect: "status+marker", marker: /if you have telegram/i, markerSemantics: "present" },
  { platform: "mastodon.social", urlFor: (h) => `https://mastodon.social/@${h}`, detect: "status" },
  { platform: "reddit", urlFor: (h) => `https://www.reddit.com/user/${h}`, detect: "status" },
  { platform: "youtube", urlFor: (h) => `https://www.youtube.com/@${h}`, detect: "status" },
  { platform: "hackernews", urlFor: (h) => `https://news.ycombinator.com/user?id=${h}`, detect: "status+marker", marker: /no such user/i, markerSemantics: "absent" },
  // === Gaming ===
  { platform: "steam", urlFor: (h) => `https://steamcommunity.com/id/${h}`, detect: "status+marker", marker: /could not be found/i, markerSemantics: "absent" },
  { platform: "chess.com", urlFor: (h) => `https://www.chess.com/member/${h}`, detect: "status" },
  { platform: "itch.io", urlFor: (h) => `https://itch.io/profile/${h}`, detect: "status" }, // unverified
  { platform: "twitch", urlFor: (h) => `https://www.twitch.tv/${h}`, detect: "status" }, // unverified: may redirect (→ unknown, safe)
  // --- Content / funding pages (rich identity context when they exist) ---
  { platform: "soundcloud", urlFor: (h) => `https://soundcloud.com/${h}`, detect: "status" },
  { platform: "patreon", urlFor: (h) => `https://www.patreon.com/${h}`, detect: "status" }, // unverified: historically soft-404s
  { platform: "ko-fi", urlFor: (h) => `https://ko-fi.com/${h}`, detect: "status" },
  { platform: "buymeacoffee", urlFor: (h) => `https://www.buymeacoffee.com/${h}`, detect: "status" },
  // --- Personal-page / identity hubs ---
  { platform: "keybase", urlFor: (h) => `https://keybase.io/${h}`, detect: "status" },
  { platform: "about.me", urlFor: (h) => `https://about.me/${h}`, detect: "status" },
  { platform: "gravatar", urlFor: (h) => `https://gravatar.com/${h}`, detect: "status" }, // unverified
  { platform: "dribbble", urlFor: (h) => `https://dribbble.com/${h}`, detect: "status" },
];

export interface ExistenceProbeResult {
  probes: Array<{
    platform: string;
    handle: string;
    url: string;
    outcome: ProbeOutcome;
    httpStatus: number;
  }>;
}

/** DI seam for the HTTP GET. Returns the final HTTP status plus the first
 *  ~4KB of the body (markers never need more). */
export interface ExistenceProbeDeps {
  fetchText?: (url: string) => Promise<{ status: number; body: string }>;
}

const UA = "osint-ai/2.0 (research; existence probe)";
const TIMEOUT_MS = 8_000;
/** Small worker pool: keeps at most 4 requests in flight (well under the ~8
 *  politeness ceiling) while still finishing 25 targets × 3 handles quickly. */
const CONCURRENCY = 4;
const BODY_READ_LIMIT = 4096;

/** Real-network fetchText: manual redirects (3xx → visible status → unknown),
 *  8s hard timeout, ~4KB body cap. Never throws — network failure returns
 *  status 0, which classifies as unknown upstream. */
async function defaultFetchText(url: string): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
      signal: controller.signal,
    });
    let body = "";
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      while (bytes < BODY_READ_LIMIT) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
        bytes += value.byteLength;
      }
      body += decoder.decode();
      await reader.cancel().catch(() => {});
    } else {
      body = await res.text();
    }
    return { status: res.status, body: body.slice(0, BODY_READ_LIMIT) };
  } catch {
    return { status: 0, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Conservative classification. "unknown" is always the safe answer:
 *  404/410 → absent; 200 → status/marker logic; anything else (3xx redirect,
 *  401/403 bot wall, 5xx, status 0 network failure) → unknown. */
function classify(status: number, body: string, target: ProbeTarget): ProbeOutcome {
  if (status === 404 || status === 410) return "absent";
  if (status !== 200) return "unknown";
  if (target.detect === "status") return "exists";
  const hit = target.marker ? target.marker.test(body) : false;
  if (target.markerSemantics === "absent") return hit ? "absent" : "exists";
  return hit ? "exists" : "unknown";
}

/**
 * Probe every curated target for the top-tier handles. The orchestrator
 * seeds this with the web sweep's bridge owners / cluster handles (the
 * likely CURRENT identities) — ordering of the input is preserved in the
 * output so results are deterministic across runs.
 */
export async function runExistenceProbes(
  handles: string[],
  opts: { maxHandles?: number; deps?: ExistenceProbeDeps } = {},
  onProgress?: (msg: string) => void,
): Promise<ExistenceProbeResult> {
  const maxHandles = opts.maxHandles ?? 3;
  const fetchText = opts.deps?.fetchText ?? defaultFetchText;

  // Dedupe case-insensitively (handles are case-insensitive on every target
  // platform here), strip a leading @, drop degenerate values.
  const seen = new Map<string, string>();
  for (const raw of handles) {
    const h = raw.replace(/^@/, "").trim();
    if (h.length < 2) continue;
    const key = h.toLowerCase();
    if (!seen.has(key)) seen.set(key, h);
  }
  const probeHandles = [...seen.values()].slice(0, maxHandles);

  // Deterministic task order: handle order (input) × target order (table).
  // Results are written into a preallocated array by task index so completion
  // order can never shuffle the output.
  const tasks: Array<{ handle: string; target: ProbeTarget }> = [];
  for (const handle of probeHandles) {
    for (const target of PROBE_TARGETS) tasks.push({ handle, target });
  }
  const probes: ExistenceProbeResult["probes"] = new Array(tasks.length);

  onProgress?.(
    `[existence-probe] Probing ${probeHandles.length} handle(s) across ${PROBE_TARGETS.length} platforms...`,
  );

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      const { handle, target } = tasks[i];
      const url = target.urlFor(handle);
      // Per-probe resilience: any failure (throw or status 0) → unknown.
      try {
        const { status, body } = await fetchText(url);
        probes[i] = {
          platform: target.platform,
          handle,
          url,
          outcome: classify(status, body, target),
          httpStatus: status,
        };
      } catch {
        probes[i] = { platform: target.platform, handle, url, outcome: "unknown", httpStatus: 0 };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(tasks.length, 1)) }, () => worker()),
  );

  const exists = probes.filter((p) => p.outcome === "exists").length;
  onProgress?.(`[existence-probe] Done: ${exists} exists / ${probes.length - exists} absent-or-unknown.`);
  return { probes };
}

/** Report block: EXISTS rows first (the actionable leads), then a one-line
 *  rollup of the rest. Frames every hit as a lead — existence is not
 *  identity. Returns "" when there is nothing to show. */
export function renderExistenceProbeBlock(result: ExistenceProbeResult): string {
  const exists = result.probes.filter((p) => p.outcome === "exists");
  const absent = result.probes.filter((p) => p.outcome === "absent").length;
  const unknown = result.probes.filter((p) => p.outcome === "unknown").length;
  if (exists.length === 0 && absent === 0 && unknown === 0) return "";

  const lines: string[] = [
    "## Username Existence Probes",
    "",
    "Deterministic unauthenticated GET checks of `platform/<handle>` across a",
    "curated site list. Existence does NOT mean same person — every row is a",
    "lead for verification, not identity evidence.",
    "",
    "| Platform | Handle | Outcome | URL |",
    "|---|---|---|---|",
  ];
  for (const p of exists) {
    lines.push(`| ${p.platform} | ${p.handle} | exists | ${p.url} |`);
  }
  lines.push("");
  lines.push(`${absent} absent / ${unknown} unknown probes omitted (leads suppressed only by absence, never established).`);
  return lines.join("\n");
}

/** Compact ground-truth-style prompt injection: only EXISTS hits, framed as
 *  unverified leads the synthesis agent must corroborate before attributing. */
export function renderExistenceProbeContextForPrompt(result: ExistenceProbeResult): string {
  const exists = result.probes.filter((p) => p.outcome === "exists");
  if (exists.length === 0) return "";
  const lines = [
    "USERNAME EXISTENCE PROBES (deterministic; leads, not identity evidence — same-person unverified):",
    ...exists.map((p) => `- ${p.platform}: profile exists at ${p.url} (same-person unverified)`),
  ];
  return lines.join("\n");
}
