/**
 * The one home for identifier MATCHING rules.
 *
 * Every deterministic pass asks the same handful of questions — "is this a
 * profile URL, and whose?", "is this word platform plumbing?", "is this a
 * role mailbox?", "does this text mention handle h?", "does this look like a
 * real name?". Each used to answer them with its own copy of a regex, and the
 * copies drifted (hyphen tokens matching in one file but not another, `@h`
 * never matching, URL fragments rejected here but counted there). Drifted
 * seed hygiene is the fake-bridge bug, so the rules live here once and every
 * caller imports them.
 *
 * Mention detection has two strengths:
 *   - findHandleMentions / mentionsHandle (BRIDGE mode, web pages and bios):
 *     a token match. Hyphens join handle tokens (`john-dev` never mentions
 *     `john`), `@h` matches, `h@domain` / `me@h.dev` (emails) do not, and a
 *     `/h` hit counts only as the terminal segment of a URL path
 *     (`x.com/h`, `u/h`), so `/h/i/x` fragments and `Google/h` never match.
 *   - disclosesHandle (DISCLOSURE mode, the subject's own Reddit text): a
 *     bridge-mode hit that ALSO sits in handle-shaped context — `@h`, `u/h`,
 *     a profile URL, or a platform/identity word nearby ("my github is h").
 *     A discovered handle that happens to be a common word ("I interned at
 *     Microsoft") is prose, not a disclosure.
 */

import { normalizeHandleKey } from "./extract.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Platform table
 * ──────────────────────────────────────────────────────────────────────── */

/** Mastodon instance hosts we read handles from (regex source). */
const MASTODON_HOSTS = String.raw`mastodon\.[a-z.]+|mstdn\.[a-z.]+|fosstodon\.org|hachyderm\.io|infosec\.exchange`;

/** Host test for the Mastodon instances in SOCIAL_PATTERNS. */
export const MASTODON_HOST_RE = new RegExp(`(^|\\.)(${MASTODON_HOSTS})$`, "i");

/** URL start: an explicit scheme, or a bare host not glued to a preceding
 *  word/email/path (`github.com/x` in prose counts; `me@github.com/x` and
 *  `foo.github.com/x` do not). */
const URL_START = String.raw`(?:https?:\/\/|(?<![\w.@/-]))`;

/**
 * Profile-URL patterns per platform. `reject` lists first path segments that
 * are platform plumbing, not people; web-sweep's profileRootHandle reads the
 * same lists via isReservedProfilePath so extraction and scrape selection can
 * never disagree about what a profile is.
 */
export const SOCIAL_PATTERNS: Array<{
  platform: string;
  pattern: RegExp;
  reject?: RegExp;
}> = [
  {
    platform: "linkedin",
    pattern: new RegExp(String.raw`${URL_START}(?:[\w-]+\.)?linkedin\.com\/in\/([A-Za-z0-9_-]+)`, "gi"),
  },
  {
    platform: "x",
    pattern: new RegExp(String.raw`${URL_START}(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)(?=\b|\/|$)`, "gi"),
    reject:
      /^(home|search|explore|intent|share|hashtag|notifications|messages|settings|i|compose|login|signup|tos|privacy|about)$/i,
  },
  {
    platform: "github",
    pattern: new RegExp(String.raw`${URL_START}(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})(?=\b|\/|$)`, "gi"),
    reject:
      /^(issues|pull|search|trending|trending_repos|marketplace|orgs|topics|collections|notifications|settings|new|features|pricing|enterprise|sponsors|readme|about|contact|login|join|signup|security|nonprofit|customer-stories|events|codespaces|copilot|gist|download|downloads|blog|docs|community|universe|githubuniverse|mobile|explore)$/i,
  },
  {
    platform: "youtube",
    pattern: new RegExp(String.raw`${URL_START}(?:www\.)?youtube\.com\/(?:@|channel\/|user\/|c\/)([A-Za-z0-9_-]+)`, "gi"),
  },
  {
    platform: "instagram",
    pattern: new RegExp(String.raw`${URL_START}(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)(?=\b|\/|$)`, "gi"),
    reject: /^(p|reel|reels|tv|accounts|explore|stories|about|developer)$/i,
  },
  {
    platform: "bluesky",
    pattern: new RegExp(String.raw`${URL_START}(?:www\.)?bsky\.app\/profile\/([A-Za-z0-9_.:-]+)`, "gi"),
  },
  {
    platform: "reddit",
    pattern: new RegExp(String.raw`${URL_START}(?:www\.|old\.)?reddit\.com\/(?:u|user)\/([A-Za-z0-9_-]+)`, "gi"),
  },
  {
    platform: "hackernews",
    pattern: new RegExp(String.raw`${URL_START}news\.ycombinator\.com\/user\?id=([A-Za-z0-9_-]+)`, "gi"),
  },
  {
    platform: "telegram",
    pattern: new RegExp(String.raw`${URL_START}(?:www\.)?t\.me\/([A-Za-z0-9_]+)`, "gi"),
    reject: /^(joinchat|s)$/i,
  },
  {
    platform: "gitlab",
    pattern: new RegExp(String.raw`${URL_START}(?:www\.)?gitlab\.com\/([A-Za-z0-9][A-Za-z0-9_-]+)(?=\b|\/|$)`, "gi"),
    reject: /^(explore|help|users|projects|search|public|dashboard|admin|signin|register|about)$/i,
  },
  {
    platform: "stackoverflow",
    pattern: new RegExp(String.raw`${URL_START}stackoverflow\.com\/users\/(\d+)`, "gi"),
  },
  {
    platform: "mastodon",
    pattern: new RegExp(String.raw`${URL_START}(${MASTODON_HOSTS})\/@([A-Za-z0-9_]+)`, "gi"),
  },
];

/** Is `segment` a reserved (non-person) first path segment on `platform`? */
export function isReservedProfilePath(platform: string, segment: string): boolean {
  return SOCIAL_PATTERNS.find((p) => p.platform === platform)?.reject?.test(segment) ?? false;
}

/**
 * Words that must never snowball into SEARCH SEEDS. Extracted "handles" like
 * `github` (the org), `download`, `trending_repos` are platform plumbing, not
 * people — and they are POISONOUS twice over: the search battery wastes
 * queries on them, and a seed named "github" then matches the word GitHub on
 * every scraped page, manufacturing fake bridge edges wholesale. Also
 * excluded as mention targets in bridge detection and as graph nodes.
 * Stored as normalizeHandleKey keys (`trending_repos` → `trendingrepos`),
 * the form every caller looks them up in.
 */
export const RESERVED_SEED_WORDS = new Set([
  "github", "gitlab", "git", "twitter", "x", "instagram", "linkedin", "reddit",
  "telegram", "youtube", "discord", "twitch", "medium", "substack", "tiktok",
  "facebook", "threads", "mastodon", "bluesky", "bsky", "snapchat", "pinterest",
  "download", "downloads", "trending", "trending_repos", "explore", "search",
  "login", "signup", "signin", "home", "about", "contact", "blog", "docs",
  "developer", "status", "events", "universe", "help", "support", "settings",
  "notifications", "new", "org", "orgs", "com", "www", "app", "api", "mail",
].map(normalizeHandleKey));

/** Reserved word or too short (< 3 normalized chars) to seed or match on. */
export function isSeededHandleWord(handle: string): boolean {
  const norm = normalizeHandleKey(handle);
  return norm.length < 3 || RESERVED_SEED_WORDS.has(norm);
}

/* ────────────────────────────────────────────────────────────────────────
 * Mailboxes
 * ──────────────────────────────────────────────────────────────────────── */

/** Vendor/system mailbox local parts — abuse@, dmca@, noreply@ … belong to
 *  the SITE that was scraped, not to the subject. */
const ROLE_MAILBOX_LOCALPARTS = /^(abuse|dmca|noreply|no-?reply|donotreply|info|support|help|privacy|legal|partners|contact|sales|admin|administrator|webmaster|security|postmaster|marketing|press|media|team|hello|hi|office|mail|billing|trust|safety|copyright|compliance)$/i;

/** Role/system mailbox (abuse@, info@, noreply@ …): never the subject's
 *  identity unless it sits on their own site's domain. */
export function isRoleMailbox(email: string): boolean {
  return ROLE_MAILBOX_LOCALPARTS.test(email.split("@")[0] ?? "");
}

/** Search-seed filter: role mailboxes plus very short local parts (too
 *  generic to search). */
export function isVendorEmail(email: string): boolean {
  return (email.split("@")[0] ?? "").length < 4 || isRoleMailbox(email);
}

/**
 * Mailboxes that carry no identity at all: GitHub-generated noreply/bot
 * addresses and generic noreply locals. They never become email nodes or
 * corroboration clusters. (Short locals like jd@corp.com are real people.)
 */
export function isContentlessEmail(email: string): boolean {
  return /@(users|bots)\.noreply\.github\.com$|^dependabot\[bot\]@|^(noreply|no-reply|donotreply)@/i.test(email);
}

/* ────────────────────────────────────────────────────────────────────────
 * Names
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Does a display name look like a real person's name (not a handle echo)?
 * ≥2 alphabetic tokens, at least one properly capitalized, and not just the
 * handle re-spelled. "Rohan Sharma" yes; "0x crypto whale" no; "rohan" no.
 * Omit `handle` for GitHub profile/commit names: a GitHub `name` field is a
 * separate declaration even when the login was derived from it ("John Doe" /
 * johndoe is a real name), and single-token echoes like "fixturenew" already
 * fail the two-token rule.
 */
export function nameLooksReal(name: string, handle?: string): boolean {
  const tokens = name
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-zÀ-ž'-]/g, ""))
    .filter((t) => t.length >= 2);
  if (tokens.length < 2) return false;
  if (handle !== undefined) {
    if (tokens.join("").toLowerCase() === normalizeHandleKey(handle)) return false;
    const raw = handle.replace(/^@/, "").toLowerCase();
    if (tokens.every((t) => t.toLowerCase() === raw)) return false;
  }
  return tokens.some((t) => /^[A-ZÀ-Ž]/.test(t));
}

/** Normalize a personal name for comparison: lowercase, collapse whitespace,
 *  strip punctuation that separates name tokens (keeps internal initials). */
export function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[.,;:!?'"—–-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Tokenize a name for overlap matching: lowercase, drop tokens < 2 chars. */
export function nameTokens(raw: string): string[] {
  const t = normalizeName(raw).split(/\s+/).filter((tok) => tok.length >= 2);
  return [...new Set(t)];
}

/** Do two names share enough tokens to be the same person? Two shared tokens,
 *  or one shared token of ≥3 chars (a lone surname match). */
export function namesOverlap(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  const shared = tb.filter((t) => ta.includes(t));
  return shared.length >= 2 || (shared.length === 1 && shared[0].length >= 3);
}

/* ────────────────────────────────────────────────────────────────────────
 * Mention detection
 * ──────────────────────────────────────────────────────────────────────── */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Text before a `/h` hit that makes it a URL path: a host (with any
 *  intermediate path) or a Reddit-style `u/` / `user/` prefix. */
const URL_PATH_PREFIX_RE = /(?:\b(?:u|user)|[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s/]+)*)\/$/i;

/** Is the hit at [start, end) a handle token rather than part of an email,
 *  a deeper URL path, or a slash-joined word list? */
function acceptToken(text: string, start: number, end: number): boolean {
  const after = text.slice(end, end + 64);
  if (/^@[\w-]+\.[a-z]/i.test(after)) return false; // h@domain — an email local part
  const prev = text[start - 1];
  if (prev === "@") return !/[\w.%+-]/.test(text[start - 2] ?? ""); // me@h.dev — an email domain
  if (prev === "/") {
    // Terminal path segment of a URL (x.com/h, x.com/h/, u/h) only.
    return /^\/?(?![\w/-])/.test(after) && URL_PATH_PREFIX_RE.test(text.slice(Math.max(0, start - 200), start));
  }
  return true;
}

/** Start offsets of every accepted token hit of `handle` in `text`. */
function tokenHits(text: string, handle: string): number[] {
  const h = handle.replace(/^@/, "");
  if (!text || !h) return [];
  // Leading guard: no word char, hyphen (joins handle tokens) or URL query
  // metachar (`?id=h`, `&u=h`). `/` and `@` pass here and are vetted by
  // acceptToken.
  const re = new RegExp(`(?<![\\w=&?-])${escapeRegExp(h)}(?![\\w-])`, "gi");
  const out: number[] = [];
  for (const m of text.matchAll(re)) {
    if (acceptToken(text, m.index, m.index + h.length)) out.push(m.index);
  }
  return out;
}

/** Up to `max` start offsets where `text` mentions `handle` (BRIDGE mode —
 *  see the module header for the token rules). */
export function findHandleMentions(text: string, handle: string, max = 3): number[] {
  return tokenHits(text, handle).slice(0, max);
}

/** Does `text` mention `handle` as a token (BRIDGE mode)? */
export function mentionsHandle(text: string, handle: string): boolean {
  return tokenHits(text, handle).length > 0;
}

/** Platform / identity words that make a nearby token a handle. */
const HANDLE_CONTEXT_RE =
  /\b(?:github|gitlab|codeberg|twitter|on x|x\.com|insta(?:gram)?|ig|discord|telegram|steam|twitch|youtube|reddit|linkedin|tiktok|bluesky|bsky|mastodon|snapchat|handle|username|user ?name|gamertag|alt|account|(?:find|follow|add|dm) me)\b/i;
/** "my <anything short> is h" / "my github: h" immediately before the hit. */
const MY_IS_RE = /\bmy\b[^.!?\n]{0,30}?(?:\bis\b|[:=])\s*["'`]?$/i;
/** Context window (chars) on each side of a hit for HANDLE_CONTEXT_RE. */
const CONTEXT_WINDOW = 40;

/** Cues that a nearby mention is the writer's OWN identity: rename history or
 *  an alt-account note. This is what separates a stale-badge bridge from a
 *  link list that happens to name the handle. */
const SELF_REFERENCE_CUE =
  /\b(?:previously|formerly|aka|a\.k\.a\.?|also known as|old (?:handle|account|username|name)|renamed (?:from|to)|used to be|my (?:old|new|alt|other|main|backup|second) (?:handle|account|username)|alt(?:ernate)? account|main account|backup account)\b/i;

/** Cues that the mentioned handle belongs to SOMEONE ELSE ("my friend's github
 *  is h", "check out h"). */
const THIRD_PARTY_CUE =
  /\b(?:my (?:friend|buddy|colleague|coworker|brother|sister|partner|roommate)(?:'s|s')?|a friend(?:'s)?|shoutout to|credit(?:s)? to|thanks to|inspired by|follow (?:him|her|them))\b/i;

/** How a bridge-mode mention relates to the page owner. */
export type MentionClass = "self-reference" | "ambient";

/**
 * Classify a bridge-mode mention of `handle` by the cues around it.
 * `self-reference` = a rename/alt cue sits within the context window (the
 * writer is naming their own old handle); everything else is `ambient` — a
 * mention that may just be a link list or a shoutout. Bridge scoring keeps
 * ambient mentions below the person-merge line: they are recorded as leads,
 * not as identity fusion.
 */
export function classifyMention(text: string, handle: string): MentionClass {
  const len = handle.replace(/^@/, "").length;
  for (const start of tokenHits(text, handle)) {
    const before = text.slice(Math.max(0, start - CONTEXT_WINDOW), start);
    const after = text.slice(start + len, start + len + CONTEXT_WINDOW);
    const window = `${before} ${after}`;
    // A third-party cue beats the nearby platform word ("my friend's github is h").
    if (THIRD_PARTY_CUE.test(before)) continue;
    if (MY_IS_RE.test(before) || SELF_REFERENCE_CUE.test(window)) return "self-reference";
    if (HANDLE_CONTEXT_RE.test(window)) return "self-reference";
  }
  return "ambient";
}

/** Who a disclosure names: the writer (`self`) or someone they point at. */
export type DisclosureKind = "self" | "third-party";

/**
 * First place the subject's own text DISCLOSES `handle`, with its kind, or
 * null. A disclosure is a bridge-mode token hit in handle-shaped context:
 * `@h`, `u/h` or a non-table URL ending in h, a platform/identity word within
 * ~40 chars ("my discord is h", "h on github"), or "my … is h". A third-party
 * cue ("my friend's github is h") downgrades the link — the handle is real but
 * it may be a different person. Plain prose ("I interned at Microsoft") never
 * counts, so a discovered handle that is also an ordinary word cannot
 * fabricate a disclosure edge.
 */
export function disclosureKind(text: string, handle: string): { kind: DisclosureKind; index: number } | null {
  const len = handle.replace(/^@/, "").length;
  // Profile URLs from the platform table are the corpus regex extractor's
  // observation (counted there, once); blank them (offsets preserved) so a
  // post's own extracted link is never ALSO a verbal disclosure.
  let verbal = text;
  for (const { pattern } of SOCIAL_PATTERNS) verbal = verbal.replace(pattern, (m) => " ".repeat(m.length));
  for (const start of tokenHits(verbal, handle)) {
    const prev = verbal[start - 1];
    if (prev === "@" || prev === "/") return { kind: "self", index: start };
    const before = verbal.slice(Math.max(0, start - CONTEXT_WINDOW), start);
    const after = verbal.slice(start + len, start + len + CONTEXT_WINDOW);
    if (THIRD_PARTY_CUE.test(before)) return { kind: "third-party", index: start };
    if (MY_IS_RE.test(before)) return { kind: "self", index: start };
    if (HANDLE_CONTEXT_RE.test(`${before} ${after}`)) return { kind: "self", index: start };
  }
  return null;
}

/** Offset of the first disclosure of `handle` (either kind), or -1. */
export function disclosesHandle(text: string, handle: string): number {
  return disclosureKind(text, handle)?.index ?? -1;
}

/** First-person residence cues: a place named right after one is where the
 *  writer lives (or lived), not a city they visited or read about. */
const RESIDENCE_CUE = String.raw`(?:i\s+(?:live|lived|reside|grew\s+up)\s+in|i\s+(?:moved|relocated)\s+to|(?:i'?m|i\s+am)\s+(?:based|living|located)\s+(?:in|out\s+of)|(?:i'?m|i\s+am)\s+from)`;

/**
 * Offset of `place` where the subject's own text states residence in it
 * ("I live in San Francisco", "I'm based in Pune"), or -1. Corroborates a
 * location without an LLM finding; the first-person cue keeps "I visited
 * Paris" or "news from Delhi" from counting. Questions and hypothetical
 * clauses are not assertions, even when they contain the same cue.
 */
export function statesResidence(text: string, place: string): number {
  const p = place.trim();
  if (p.length < 3) return -1;
  const re = new RegExp(String.raw`\b${RESIDENCE_CUE}\s+(?:the\s+)?(${escapeRegExp(p)})(?![\w-])`, "gi");
  for (const m of text.matchAll(re)) {
    const before = text.slice(0, m.index).split(/[,.!?;\n]|\b(?:but|however)\b/i).at(-1) ?? "";
    const after = text.slice(m.index + m[0].length);
    if (/\b(?:if|unless|suppose|supposing|imagine|wish|whether)\b/i.test(before)) continue;
    if (/\b(?:can|could|should|would|may|might|must|do|did)\s*$/i.test(before)) continue;
    if (/^[^,.!?;\n]*\?/.test(after)) continue;
    return m.index + m[0].length - m[1].length;
  }
  return -1;
}

/** Whitespace-collapsed excerpt around [idx, idx+len), ellipsized where cut
 *  and capped at 160 chars — the evidence snippet for a mention. */
export function snippetAround(text: string, idx: number, len: number, radius = 60): string {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + len + radius);
  const core = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${core}${end < text.length ? "…" : ""}`.slice(0, 160);
}
