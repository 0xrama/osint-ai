/**
 * Deterministic Twitter/X identity pass via the external `twitter-cli`.
 *
 * Search engines largely cannot see X profile pages (login walls, bot defense),
 * so the web sweep under-reports one of the richest identity surfaces. This
 * module shells out to the operator-installed `twitter-cli` (audited — see
 * AGENTS.md §8), which authenticates with the operator's burner-account cookies
 * (TWITTER_AUTH_TOKEN/TWITTER_CT0 env vars or browser cookie extraction, both
 * handled by twitter-cli itself — this module never touches credentials) and
 * reads profiles through X's own GraphQL endpoints.
 *
 * What it adds to the investigator loop (the fixtureveil → fixturenew walkthrough):
 *   1. Profile fields no scraper reliably gets: display name, bio, location,
 *      website URL, join date (createdAt), follower/following counts.
 *   2. Follow-graph triage: among the accounts a seed follows, deterministically
 *      rank ALT-ACCOUNT CANDIDATES — accounts whose username shares a scheme
 *      with known handles (same 0x prefix, drift variants, small edit distance)
 *      and whose display name looks like a real person's name (e.g. a 0x
 *      username with an Indian-name display name). The subject's other account
 *      usually sits in their own following list.
 *   3. Squatter evidence: createdAt lets us flag handles whose X account was
 *      created AFTER the subject's Reddit account — a reclaimed handle whose
 *      content (crypto spam, another language) may belong to a squatter, not
 *      the subject. Flagged, never auto-attributed.
 *
 * READ-ONLY BY CONSTRUCTION: the subcommand is checked against an allowlist
 * (status/whoami/user/user-posts/following/followers/search) and write
 * subcommands are unrepresentable in this API surface.
 *
 * All errors are swallowed per call (missing handle, rate limit, auth failure)
 * so the pass degrades gracefully and never aborts a run.
 */

import { spawn } from "node:child_process";
import {
  extractDirectIdentifiers,
  extractEmails,
  extractSocialHandles,
  normalizeHandleKey,
  type DirectIdentifiers,
} from "./extract.ts";
import { followWebsite } from "./site-follower.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────── */

/** One X profile as returned by `twitter user <handle> --json` (twitter-cli
 *  SCHEMA.md envelope). Fields are normalized from both camelCase (structured
 *  output) and snake_case (GraphQL legacy) shapes defensively. */
export interface TwitterUserProfile {
  id: string;
  name: string;
  screenName: string;
  bio: string;
  location: string;
  /** Website URL from the profile (the "main website" lead). */
  url: string;
  followers: number;
  following: number;
  tweets: number;
  likes: number;
  verified: boolean;
  profileImageUrl: string;
  /** Raw twitter-format join date (e.g. "Sun Jun 14 04:10:38 +0000 2020"). */
  createdAt: string;
  /** ISO-8601 join date when the CLI provided one. */
  createdAtISO?: string;
}

/** A followed account ranked as a likely alternate/related identity. */
export interface TwitterAltCandidate {
  profile: TwitterUserProfile;
  /** Triage score (higher = stronger same-person signal). */
  score: number;
  /** Human-readable reasons for the score (rendered verbatim). */
  reasons: string[];
  /** Up to 3 recent tweet text samples (identifier/context gold). */
  tweetSamples?: string[];
  /** Text of the candidate's website (identity sub-pages followed), capped. */
  siteText?: string;
}

/** Per-seed outcome of the pass. */
export interface TwitterSeedResult {
  seed: string;
  profile?: TwitterUserProfile;
  /** True when this handle's X account was created well AFTER the subject's
   *  Reddit account — a reclaimed-handle warning (squatter risk), never an
   *  attribution. */
  reclaimed?: boolean;
  followingScanned: number;
  altCandidates: TwitterAltCandidate[];
}

export interface TwitterPassResult {
  seeds: string[];
  results: TwitterSeedResult[];
  identifiers: DirectIdentifiers;
  /** Provenance: identifier (lc) -> source URLs it was seen on. */
  identifierSources: {
    emails: Record<string, string[]>;
    handles: Record<string, string[]>;
  };
  rateLimited: boolean;
  /** The operator's own (burner) account — excluded from all results. */
  operatorHandle?: string;
}

/** Dependency-injection seam: tests inject a deterministic fake exec; the
 *  default shells out to the real twitter-cli binary. */
export interface TwitterDeps {
  exec?: (args: string[], timeoutMs: number) => Promise<{ stdout: string; code: number }>;
}

/* ────────────────────────────────────────────────────────────────────────
 * Exec plumbing (spawn convention mirrors providers/claude-code.ts)
 * ──────────────────────────────────────────────────────────────────────── */

const DEFAULT_TIMEOUT_MS = 90_000;
const AVAILABILITY_TTL_MS = 5 * 60_000;

/** The ONLY subcommands this integration may invoke. Write operations
 *  (tweet/reply/like/retweet/follow/unfollow/delete/…) are unrepresentable. */
const READ_ONLY_COMMANDS = new Set([
  "status", "whoami", "user", "user-posts", "following", "followers", "search",
]);

function twitterBin(): string {
  return process.env.TWITTER_CLI_BIN || "twitter";
}

/** Hard gate: any attempt to run a non-read subcommand throws immediately.
 *  Exported for unit tests — the property "write commands are unrepresentable"
 *  is a deliberate design guarantee, not an implementation detail. */
export function assertReadOnly(args: string[]): void {
  const cmd = String(args[0] ?? "");
  if (!READ_ONLY_COMMANDS.has(cmd)) {
    throw new Error(
      `twitter-pass: refusing to invoke twitter-cli subcommand "${cmd}" — this integration is read-only by design (${[...READ_ONLY_COMMANDS].join("/")} only).`,
    );
  }
}

function cleanHandle(handle: string): string {
  return String(handle ?? "").replace(/^@/, "").trim();
}

/** Spawn the CLI with a hard timeout. Non-zero exit codes are RESOLVED (not
 *  rejected) so callers can parse the structured error envelope (e.g. a
 *  not_found user is a normal outcome); spawn/timeout failures reject. */
async function twitterExec(
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ stdout: string; code: number }> {
  assertReadOnly(args);
  const bin = twitterBin();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`twitter-cli request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error(
          `twitter-pass: '${bin}' not found in PATH. Install twitter-cli (uv tool install twitter-cli) or set TWITTER_CLI_BIN.`,
        ));
      } else {
        reject(new Error(`twitter-pass spawn failed: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, code: code ?? 1 });
    });
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * Envelope + profile parsing (twitter-cli SCHEMA.md contract)
 * ──────────────────────────────────────────────────────────────────────── */

interface TwitterEnvelope {
  ok: boolean;
  data?: any;
  error?: { code?: string; message?: string };
}

function parseEnvelope(stdout: string): TwitterEnvelope | null {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") {
      return parsed as TwitterEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

function toInt(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Normalize a user dict from either the camelCase structured shape or the
 *  snake_case GraphQL legacy shape. Returns null when no handle is present. */
function normalizeUserProfile(raw: any): TwitterUserProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const screenName = String(raw.screenName ?? raw.screen_name ?? "").replace(/^@/, "").trim();
  if (!screenName) return null;
  return {
    id: String(raw.id ?? raw.rest_id ?? ""),
    name: String(raw.name ?? ""),
    screenName,
    bio: String(raw.bio ?? raw.description ?? ""),
    location: String(raw.location ?? ""),
    url: String(raw.url ?? ""),
    followers: toInt(raw.followers ?? raw.followers_count),
    following: toInt(raw.following ?? raw.friends_count),
    tweets: toInt(raw.tweets ?? raw.statuses_count),
    likes: toInt(raw.likes ?? raw.favourites_count),
    verified: Boolean(raw.verified ?? false),
    profileImageUrl: String(raw.profileImageUrl ?? raw.profile_image_url ?? ""),
    createdAt: String(raw.createdAt ?? raw.created_at ?? ""),
    createdAtISO: raw.createdAtISO ? String(raw.createdAtISO) : undefined,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Availability probe (cached)
 * ──────────────────────────────────────────────────────────────────────── */

let availabilityCache: { checkedAt: number; available: boolean; operator?: string } | null = null;

/**
 * True when the twitter-cli binary exists AND reports an authenticated
 * session (`status --json` → ok:true). Cached for 5 minutes — the pipeline
 * gates the whole pass on this, and the probe itself costs a network call.
 */
export async function twitterAvailable(deps: TwitterDeps = {}): Promise<boolean> {
  if (
    availabilityCache &&
    Date.now() - availabilityCache.checkedAt < AVAILABILITY_TTL_MS
  ) {
    return availabilityCache.available;
  }
  const doExec = deps.exec ?? twitterExec;
  assertReadOnly(["status", "--json"]);
  try {
    const { stdout, code } = await doExec(["status", "--json"], 20_000);
    const env = code === 0 ? parseEnvelope(stdout) : null;
    const available = env?.ok === true;
    const user = env?.data?.user;
    availabilityCache = {
      checkedAt: Date.now(),
      available,
      operator: user
        ? String(user.screenName ?? user.username ?? "").replace(/^@/, "").toLowerCase()
        : undefined,
    };
  } catch {
    availabilityCache = { checkedAt: Date.now(), available: false };
  }
  return availabilityCache?.available ?? false;
}

/** The operator's burner account handle (from the cached status probe). */
export function twitterOperatorHandle(): string | undefined {
  return availabilityCache?.operator;
}

/* ────────────────────────────────────────────────────────────────────────
 * Read fetchers (all swallow per-call errors — see module header)
 * ──────────────────────────────────────────────────────────────────────── */

/** Fetch one profile. Null on missing handle / rate limit / any error. */
export async function fetchTwitterUser(
  handle: string,
  deps: TwitterDeps = {},
): Promise<TwitterUserProfile | null> {
  const doExec = deps.exec ?? twitterExec;
  const args = ["user", cleanHandle(handle), "--json"];
  assertReadOnly(args);
  try {
    const { stdout, code } = await doExec(args);
    if (code !== 0) return null;
    const env = parseEnvelope(stdout);
    if (env?.ok !== true) return null;
    return normalizeUserProfile(env.data);
  } catch {
    return null;
  }
}

/** Accounts a handle follows (the alt-account hunting ground). */
export async function fetchTwitterFollowing(
  handle: string,
  max = 100,
  deps: TwitterDeps = {},
): Promise<TwitterUserProfile[]> {
  const doExec = deps.exec ?? twitterExec;
  const capped = Math.max(1, Math.min(max, 200));
  const args = ["following", cleanHandle(handle), "--max", String(capped), "--json"];
  assertReadOnly(args);
  try {
    const { stdout, code } = await doExec(args);
    if (code !== 0) return [];
    const env = parseEnvelope(stdout);
    if (env?.ok !== true) return [];
    const list = Array.isArray(env.data)
      ? env.data
      : Array.isArray(env.data?.users)
        ? env.data.users
        : [];
    return list.map(normalizeUserProfile).filter((u): u is TwitterUserProfile => u !== null);
  } catch {
    return [];
  }
}

/** Recent tweet texts for a handle (identifier/context gold). */
export async function fetchTwitterUserTweets(
  handle: string,
  max = 10,
  deps: TwitterDeps = {},
): Promise<string[]> {
  const doExec = deps.exec ?? twitterExec;
  const capped = Math.max(1, Math.min(max, 200));
  const args = ["user-posts", cleanHandle(handle), "--max", String(capped), "--json"];
  assertReadOnly(args);
  try {
    const { stdout, code } = await doExec(args);
    if (code !== 0) return [];
    const env = parseEnvelope(stdout);
    if (env?.ok !== true) return [];
    const list = Array.isArray(env.data)
      ? env.data
      : Array.isArray(env.data?.tweets)
        ? env.data.tweets
        : [];
    return list
      .map((t: any) => String(t?.text ?? t?.full_text ?? "").trim())
      .filter(Boolean)
      .slice(0, capped);
  } catch {
    return [];
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Triage: alt-account ranking over the following list (pure)
 * ──────────────────────────────────────────────────────────────────────── */

/** Letter↔digit confusables for handle drift (fixtureve1l vs fixtureveil). */
const LETTER_TO_DIGIT: Record<string, string> = {
  a: "4", b: "8", e: "3", g: "9", i: "1", l: "1", o: "0", s: "5", t: "7", z: "2",
};
const DIGIT_TO_LETTER: Record<string, string> = {
  "0": "o", "1": "l", "2": "z", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g",
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * All digit/letter-drift variants of a handle (bounded Cartesian expansion —
 * handles are short and few chars are confusable, so this stays tiny).
 * `generateDriftVariants("fixtureveil")` includes "fixtureve1l", "fixtur3veil", …
 */
export function generateDriftVariants(handle: string, maxVariants = 64): string[] {
  const base = normalizeHandleKey(handle);
  if (base.length < 2) return [base];
  const choices: string[][] = [];
  for (const ch of base) {
    const set = new Set<string>([ch]);
    const mapped = LETTER_TO_DIGIT[ch] ?? DIGIT_TO_LETTER[ch];
    if (mapped) set.add(mapped);
    choices.push([...set]);
  }
  const out = new Set<string>();
  const recurse = (idx: number, acc: string): void => {
    if (out.size >= maxVariants) return;
    if (idx === choices.length) { out.add(acc); return; }
    for (const c of choices[idx]) recurse(idx + 1, acc + c);
  };
  recurse(0, "");
  return [...out];
}

/** True when a and b are drift variants of each other (either direction). */
export function isDriftVariant(a: string, b: string): boolean {
  const av = generateDriftVariants(a, 32);
  const bv = generateDriftVariants(b, 32);
  return av.some((v) => bv.includes(v)) || bv.some((v) => av.includes(v));
}

/** Classic Levenshtein edit distance (no deps). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  const limit = Math.min(a.length, b.length);
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

/**
 * Does a display name look like a real person's name (not a handle echo)?
 * ≥2 alphabetic tokens, at least one properly capitalized, and not just the
 * handle re-spelled. "Rohan Sharma" yes; "0x crypto whale" no; "rohan" no.
 */
function nameLooksReal(name: string, screenName: string): boolean {
  const tokens = name
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-zÀ-ž'-]/g, ""))
    .filter((t) => t.length >= 2);
  if (tokens.length < 2) return false;
  const stem = screenName.replace(/[._-]+/g, "").toLowerCase();
  if (tokens.join("").toLowerCase() === stem) return false;
  if (tokens.every((t) => t.toLowerCase() === screenName.toLowerCase())) return false;
  return tokens.some((t) => /^[A-ZÀ-Ž]/.test(t));
}

export interface TriageOptions {
  /** All known handles for this investigation (audited username + seeds). */
  knownHandles: string[];
  /** ISO date of the subject's Reddit account — for age-proximity scoring. */
  subjectCreatedISO?: string;
  /** Handles to never score (the operator's burner account, etc.). */
  excludeHandles?: string[];
}

/**
 * Rank a following list into alt-account candidates. Deterministic scoring:
 *   +3 username is a drift variant / within edit distance 2 of a known handle
 *   +3 (or +2 for a shared 0x-style prefix) username shares a scheme
 *   +3 bio mentions a known handle (word-boundary — an explicit self-reference)
 *   +2 display name looks like a real person's name
 *   +1 account age within ±2 years of the subject's Reddit account
 * Only accounts scoring ≥3 are candidates (top-N kept by the caller).
 */
export function rankAltCandidates(
  following: TwitterUserProfile[],
  opts: TriageOptions,
): TwitterAltCandidate[] {
  const excluded = new Set((opts.excludeHandles ?? []).map((h) => normalizeHandleKey(h)));
  const knownNorms = opts.knownHandles.map((h) => normalizeHandleKey(h)).filter(Boolean);
  const knownRaws = opts.knownHandles.map((h) => h.toLowerCase().replace(/^@/, ""));

  const scored: TwitterAltCandidate[] = [];
  for (const p of following) {
    const raw = p.screenName.toLowerCase();
    const norm = normalizeHandleKey(p.screenName);
    if (!norm || excluded.has(norm)) continue;
    if (knownNorms.includes(norm)) continue; // already a known handle, not an alt

    let score = 0;
    const reasons: string[] = [];

    // 1. Username-scheme similarity against every known handle.
    for (let i = 0; i < knownNorms.length; i++) {
      const kn = knownNorms[i];
      const kr = knownRaws[i] ?? "";
      if (!kn || !kr) continue;
      const prefix = Math.max(commonPrefixLength(raw, kr), commonPrefixLength(norm, kn));
      if (isDriftVariant(norm, kn)) {
        score += 3;
        reasons.push(`username is a digit/letter-drift variant of known handle "${opts.knownHandles[i]}"`);
        break;
      }
      const dist = levenshtein(norm, kn);
      if (kn.length >= 4 && dist <= 2) {
        score += 3;
        reasons.push(`username within edit distance ${dist} of known handle "${opts.knownHandles[i]}"`);
        break;
      }
      if (prefix >= 5) {
        score += 3;
        reasons.push(`username shares the "${raw.slice(0, prefix)}" prefix with known handle "${opts.knownHandles[i]}"`);
        break;
      }
      if (prefix >= 3 && /^(0x|_)/i.test(raw)) {
        score += 2;
        reasons.push(`same "${raw.slice(0, prefix)}" username scheme as known handle "${opts.knownHandles[i]}"`);
        break;
      }
      if (kn.length >= 4 && dist <= 3) {
        score += 1;
        reasons.push(`username close (edit distance ${dist}) to known handle "${opts.knownHandles[i]}"`);
        break;
      }
    }

    // 2. Display name looks like a real person's name.
    if (nameLooksReal(p.name, p.screenName)) {
      score += 2;
      reasons.push(`display name "${p.name}" looks like a real name`);
    }

    // 3. Bio mentions a known handle (word-boundary token match) — an
    // explicit self-reference ("alt of fixtureveil"), stronger than a name echo.
    for (const kh of knownRaws) {
      if (!kh) continue;
      const re = new RegExp(`(^|[^\\w@])${escapeRe(kh)}(?![\\w])`, "i");
      if (re.test(p.bio)) {
        score += 3;
        reasons.push(`bio mentions "${kh}"`);
        break;
      }
    }

    // 4. Account age proximity to the subject's timeline.
    if (opts.subjectCreatedISO && p.createdAtISO) {
      const subj = Date.parse(opts.subjectCreatedISO);
      const cand = Date.parse(p.createdAtISO);
      if (
        Number.isFinite(subj) && Number.isFinite(cand) &&
        Math.abs(cand - subj) <= 2 * 365.25 * 86_400_000
      ) {
        score += 1;
        reasons.push("account age close to the subject's timeline");
      }
    }

    if (score >= 3) scored.push({ profile: p, score, reasons });
  }

  scored.sort((a, b) => b.score - a.score || a.profile.screenName.localeCompare(b.profile.screenName));
  return scored;
}

/**
 * Squatter evidence: true when a handle's X account was created well AFTER the
 * subject's Reddit account. An old handle whose profile is newer than the
 * subject's own account may have been re-registered by someone else — flag,
 * never attribute. (The content-mismatch half — crypto spam, another language
 * — is left to the synthesis agent, which gets the dates as ground truth.)
 */
export function isReclaimedHandle(
  profileCreatedISO: string | undefined,
  subjectCreatedISO: string | undefined,
  slackYears = 1,
): boolean {
  if (!profileCreatedISO || !subjectCreatedISO) return false;
  const created = Date.parse(profileCreatedISO);
  const subject = Date.parse(subjectCreatedISO);
  if (!Number.isFinite(created) || !Number.isFinite(subject)) return false;
  return created - subject > slackYears * 365.25 * 86_400_000;
}

/* ────────────────────────────────────────────────────────────────────────
 * The pass
 * ──────────────────────────────────────────────────────────────────────── */

export interface TwitterPassOptions {
  maxSeeds?: number;
  followingMax?: number;
  altCandidatesMax?: number;
  /** ISO date of the subject's Reddit account (cake day) for reclaimed flags. */
  subjectCreatedISO?: string;
  deps?: TwitterDeps;
}

const MAX_SITE_TEXT = 4_000;

/**
 * Run the deterministic Twitter identity pass: profile fetch per seed, then
 * follow-graph triage → alt-candidate profiles → their tweet samples and
 * websites (link-followed, identifiers extracted with provenance). Errors are
 * swallowed per handle; the operator's burner account is always excluded.
 */
export async function runTwitterPass(
  seeds: string[],
  opts: TwitterPassOptions = {},
  onProgress?: (msg: string) => void,
): Promise<TwitterPassResult> {
  const maxSeeds = opts.maxSeeds ?? 5;
  const followingMax = opts.followingMax ?? 100;
  const altCandidatesMax = opts.altCandidatesMax ?? 5;
  const deps = opts.deps ?? {};

  const seen = new Set<string>();
  const cleanSeeds: string[] = [];
  for (const raw of seeds) {
    const h = cleanHandle(raw);
    if (h.length < 2) continue;
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleanSeeds.push(h);
  }
  const used = cleanSeeds.slice(0, maxSeeds);

  const operator = (await twitterAvailable(deps)) ? twitterOperatorHandle() : undefined;
  if (operator) {
    onProgress?.(`[twitter-pass] Operator (burner) account @${operator} is excluded from results.`);
  }

  const results: TwitterSeedResult[] = [];
  const emailSources = new Map<string, Set<string>>();
  const handleSources = new Map<string, { meta: { handle: string; url: string }; sources: Set<string> }>();
  let rateLimited = false;

  const addEmail = (email: string, source: string): void => {
    const e = email.toLowerCase();
    if (!e) return;
    const set = emailSources.get(e) ?? new Set<string>();
    if (set.size < 3) set.add(source);
    emailSources.set(e, set);
  };
  const addHandle = (platform: string, handle: string, url: string, source: string): void => {
    const key = `${platform}:${handle.toLowerCase()}`;
    const entry = handleSources.get(key) ?? { meta: { handle, url }, sources: new Set<string>() };
    if (!entry.meta.url && url) entry.meta.url = url;
    if (entry.sources.size < 3) entry.sources.add(source);
    handleSources.set(key, entry);
  };

  // Known-handle universe grows as the pass discovers alt candidates, so the
  // triage for later seeds can match earlier discoveries (snowball, small).
  const knownHandles = [...used];

  for (const seed of used) {
    onProgress?.(`[twitter-pass] Fetching @${seed} profile...`);
    const profile = await fetchTwitterUser(seed, deps);
    if (!profile) {
      results.push({ seed, followingScanned: 0, altCandidates: [] });
      onProgress?.(`[twitter-pass] @${seed}: not found (or unreadable).`);
      continue;
    }

    const profileUrl = `https://x.com/${profile.screenName}`;
    const reclaimed = isReclaimedHandle(profile.createdAtISO, opts.subjectCreatedISO);

    // Seed profile identifiers: the handle itself + anything in the bio.
    addHandle("x", profile.screenName, profileUrl, profileUrl);
    for (const h of extractSocialHandles(profile.bio)) {
      addHandle(h.platform, h.handle, h.url, profileUrl);
    }
    for (const e of extractEmails(profile.bio)) addEmail(e, profileUrl);

    // Follow-graph triage → alt candidates.
    let altCandidates: TwitterAltCandidate[] = [];
    let followingScanned = 0;
    if (profile.following > 0) {
      const following = await fetchTwitterFollowing(seed, followingMax, deps);
      followingScanned = following.length;
      const ranked = rankAltCandidates(following, {
        knownHandles,
        subjectCreatedISO: opts.subjectCreatedISO,
        excludeHandles: operator ? [operator] : [],
      });
      altCandidates = ranked.slice(0, altCandidatesMax);
      if (altCandidates.length > 0) {
        onProgress?.(
          `[twitter-pass] @${seed}: ${followingScanned} following scanned → ${altCandidates.length} alt-account candidate(s): [${altCandidates.map((a) => `@${a.profile.screenName}`).join(", ")}]`,
        );
      }
    }

    // Deepen each alt candidate: tweets + website (identity sub-pages).
    for (const alt of altCandidates) {
      const altUrl = `https://x.com/${alt.profile.screenName}`;
      addHandle("x", alt.profile.screenName, altUrl, altUrl);
      for (const h of extractSocialHandles(alt.profile.bio)) {
        addHandle(h.platform, h.handle, h.url, altUrl);
      }
      for (const e of extractEmails(alt.profile.bio)) addEmail(e, altUrl);

      const tweets = await fetchTwitterUserTweets(alt.profile.screenName, 10, deps);
      alt.tweetSamples = tweets.slice(0, 3);
      const tweetText = tweets.join("\n");
      if (tweetText) {
        for (const h of extractSocialHandles(tweetText)) {
          addHandle(h.platform, h.handle, h.url, altUrl);
        }
        for (const e of extractEmails(tweetText)) addEmail(e, altUrl);
      }

      if (alt.profile.url) {
        const site = await followWebsite(alt.profile.url).catch(() => null);
        if (site?.text && site.text.trim().length > 80) {
          alt.siteText = site.text.slice(0, MAX_SITE_TEXT);
          const di = extractDirectIdentifiers([alt.siteText]);
          for (const h of di.socialHandles) {
            addHandle(h.platform, h.handle, h.url, alt.profile.url);
          }
          for (const e of di.emails) addEmail(e, alt.profile.url);
          onProgress?.(`[twitter-pass] @${alt.profile.screenName}: website ${alt.profile.url} followed (${alt.siteText.length} chars).`);
        }
      }

      if (!knownHandles.includes(alt.profile.screenName)) {
        knownHandles.push(alt.profile.screenName);
      }
    }

    const leaks = [
      profile.name ? `name="${profile.name}"` : null,
      profile.url ? `website=${profile.url}` : null,
      profile.location ? `location="${profile.location}"` : null,
      altCandidates.length > 0 ? `${altCandidates.length} alt candidate(s)` : null,
    ].filter(Boolean).join(", ");
    onProgress?.(
      `[twitter-pass] @${seed}: ${leaks || "profile found (no obvious leaks)"}${reclaimed ? " ⚠️ account created after the subject's Reddit account — possible reclaimed handle" : ""}`,
    );
    results.push({ seed, profile, reclaimed, followingScanned, altCandidates });
  }

  const identifiers: DirectIdentifiers = {
    emails: [...emailSources.keys()],
    socialHandles: [...handleSources.entries()].map(([key, entry]) => {
      const idx = key.indexOf(":");
      return { platform: key.slice(0, idx), handle: entry.meta.handle, url: entry.meta.url };
    }),
  };

  onProgress?.(
    `[twitter-pass] ${results.length} seed(s) probed → ${identifiers.emails.length} email(s), ${identifiers.socialHandles.length} handle(s), ${results.reduce((n, r) => n + r.altCandidates.length, 0)} alt candidate(s).`,
  );

  return {
    seeds: used,
    results,
    identifiers,
    identifierSources: {
      emails: Object.fromEntries([...emailSources].map(([k, v]) => [k, [...v]])),
      handles: Object.fromEntries([...handleSources].map(([k, v]) => [k, [...v.sources]])),
    },
    rateLimited,
    operatorHandle: operator,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Report / prompt projection (mirrors github-pass.ts)
 * ──────────────────────────────────────────────────────────────────────── */

/** Convert the pass output into report-level identifier shapes (deduped by
 *  the pipeline merge, same shape as gitHubIdentifiers). */
export function twitterIdentifiers(result: TwitterPassResult): DirectIdentifiers {
  return {
    emails: [...result.identifiers.emails],
    socialHandles: [...result.identifiers.socialHandles],
  };
}

/** Render the pass as a markdown report block (LLM-independent). */
export function renderTwitterBlock(result: TwitterPassResult): string {
  const probed = result.results.filter((r) => r.profile);
  if (probed.length === 0) return "";
  const lines: string[] = [];
  lines.push(`## Twitter Identity Pass`);
  lines.push(
    `*LLM-independent Twitter/X pass via twitter-cli (operator burner account, read-only): profile fields, follow-graph alt-account triage, and website chase. ${result.seeds.length} handle(s) probed, ${probed.length} found.*${result.rateLimited ? " ⚠️ rate-limited" : ""}`,
  );
  lines.push("");

  for (const r of result.results) {
    const p = r.profile;
    if (!p) continue;
    lines.push(`### [@${p.screenName}](https://x.com/${p.screenName})`);
    const fields: Array<[string, string | undefined]> = [
      ["Display name", p.name || undefined],
      ["Location", p.location || undefined],
      ["Website", p.url || undefined],
      ["Bio", p.bio || undefined],
      ["Joined", p.createdAtISO || p.createdAt || undefined],
      ["Stats", `${p.tweets} tweets · ${p.followers} followers · ${p.following} following`],
    ];
    for (const [label, value] of fields) {
      if (value) lines.push(`- **${label}:** ${value}`);
    }
    if (r.reclaimed) {
      lines.push(
        `- ⚠️ **Reclaimed-handle warning:** this account was created after the subject's Reddit account — the content here may belong to a squatter, not the subject. Verify before attributing.`,
      );
    }
    if (r.altCandidates.length > 0) {
      lines.push(`- **Alt-account candidates from the following list** (username scheme / real-name triage):`);
      for (const alt of r.altCandidates) {
        const a = alt.profile;
        lines.push(
          `  - [@${a.screenName}](https://x.com/${a.screenName}) — *"${a.name}"*${a.url ? ` → [${a.url}](${a.url})` : ""} — score ${alt.score}: ${alt.reasons.join("; ")}`,
        );
        if (alt.siteText) {
          const idLines = alt.siteText.split("\n").filter((l) => /mailto:|@|http/.test(l)).slice(0, 3);
          if (idLines.length > 0) lines.push(`    - website leads: ${idLines.map((l) => `\`${l.trim().slice(0, 90)}\``).join(" ")}`);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Render the pass as GROUND-TRUTH context for the synthesis/live agent. */
export function renderTwitterContextForPrompt(result: TwitterPassResult): string {
  const lines: string[] = [];
  let hasContent = false;

  const push = (l: string): void => { lines.push(l); hasContent = true; };

  for (const r of result.results) {
    const p = r.profile;
    if (!p) continue;
    push(`- @${p.screenName} — display name "${p.name}"${p.location ? `, location "${p.location}"` : ""}${p.url ? `, website ${p.url}` : ""}${p.createdAtISO ? `, joined ${p.createdAtISO.slice(0, 10)}` : ""}; ${p.followers} followers / ${p.following} following.`);
    if (p.bio) push(`    bio: "${p.bio.slice(0, 200)}"`);
    if (r.reclaimed) {
      push(`    ⚠️ RECLAIMED-HANDLE WARNING: this account's join date is AFTER the subject's Reddit account. If its content style/language mismatches the subject (e.g. crypto spam, a different language), it is a squatter — do NOT attribute its posts to the subject.`);
    }
    for (const alt of r.altCandidates) {
      const a = alt.profile;
      push(`    ALT-ACCOUNT CANDIDATE (from @${p.screenName}'s following list): @${a.screenName} — display name "${a.name}" — ${alt.reasons.join("; ")}.${a.url ? ` Website: ${a.url}` : ""}`);
      push(`    This is likely the subject's alternate/current account (same username scheme, real-name display). Search "${a.name}" and @${a.screenName} on GitHub, LinkedIn, and the open web; treat the website as the subject's own.`);
      if (alt.tweetSamples?.length) {
        push(`    recent tweets: ${alt.tweetSamples.map((t) => `"${t.slice(0, 120)}"`).join(" | ")}`);
      }
    }
  }

  if (!hasContent) return "";
  return [
    "=== TWITTER IDENTITY PASS (GROUND TRUTH — twitter-cli profile/follow-graph reads, no LLM) ===",
    "These profiles and alt-account candidates were read deterministically from X via the operator's authenticated twitter-cli. Treat the profile fields (names, join dates, websites) as verified facts. The alt-account candidates are RANKED LEADS, not confirmed identities — verify each before attributing.",
    "",
    ...lines,
    "",
    "=== END TWITTER LEADS ===",
    "",
  ].join("\n");
}
