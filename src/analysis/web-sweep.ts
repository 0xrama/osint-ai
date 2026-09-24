/**
 * Deterministic web identity sweep.
 *
 * The LLM-driven synthesis is non-deterministic: one run scrapes a strong lead
 * (e.g. a GitHub profile whose bio mentions the Reddit username, exposing an
 * email + personal site), the next run ignores it and chases weaker handles.
 * This module removes that variance for the highest-value signal type — direct
 * identifiers (emails + cross-platform handles) reachable from the web — by
 * running a fixed, LLM-independent search+scrape+extract pass with our own
 * Firecrawl client.
 *
 * Method (SNOWBALL — two rounds):
 *   0. Probe the audited account's own Reddit profile bio (/about.json) —
 *      people list handles/emails/links there and forget about them.
 *   1. Round 1: fire a fixed battery of platform-targeted queries
 *      (site:github.com, site:linkedin.com/in, site:x.com, …) for the username.
 *   2. Scrape every result whose title/description/URL mentions the seed.
 *      Profile pages are scraped with onlyMainContent:false (main-content
 *      extraction drops the bio sidebar where the gold lives) and the "links"
 *      format (captures hrefs rendered as icons, incl. mailto:).
 *   3. LINK CHASE: any link-aggregator URL (linktr.ee, beacons.ai, carrd.co, …)
 *      or personal-domain link on a scraped page is scraped too — those pages
 *      are pure identity gold and never mention the audited handle.
 *   4. Extract identifiers (regex) from every page WITH PROVENANCE — each
 *      email/handle is tagged with the URLs it was seen on, so the report can
 *      show evidence, not just values.
 *   5. Round 2: the ranked output of round 1 (bridge/cluster/username handles,
 *      found emails, custom email domains) becomes NEW QUERY SEEDS. Handle B
 *      discovered via handle A is usually the CURRENT identity — searching it
 *      is far richer than re-searching the decayed one.
 *   6. Bridge detection is generalized over ALL known handles: a page owned by
 *      handle C that mentions handle B or the audited username is a stale
 *      cross-reference edge in the identity graph.
 *
 * Whatever emails/handles live on those pages are captured EVERY time,
 * regardless of which path the LLM took. Bypasses the LLM entirely.
 */

import { isFirecrawlConfigured, searchWeb, scrapeUrl, type FirecrawlSearchResult, type ScrapeResult } from "../runtime/firecrawl.ts";
import {
  extractDirectIdentifiers,
  extractEmails,
  extractSocialHandles,
  normalizeHandleKey,
  type DirectIdentifiers,
} from "./extract.ts";
import { followWebsite } from "./site-follower.ts";

export interface CandidateProfile {
  url: string;
  title: string;
  /** Why this page was selected (where it came from). */
  reason: string;
  /** True if scraping succeeded. */
  scraped: boolean;
  /** The page owner handle parsed from the URL (e.g. fixturenew for github.com/fixturenew). */
  ownerHandle?: string;
  /** Snippets from the page text where a known handle appears (bridge evidence). */
  usernameMentions?: string[];
  /** "search" = found in a search result; "chase" = followed from a scraped page's links. */
  origin?: "search" | "chase";
}

/** Provenance: where each identifier was seen (identifier (lc) -> URLs). */
export interface IdentifierSources {
  emails: Record<string, string[]>;
  /** key: platform:handle(lc) -> URLs the handle URL was found on */
  handles: Record<string, string[]>;
  /** email (lc) -> true if the domain is a free-mail provider (else custom). */
  freemail: Record<string, boolean>;
}

export interface WebSweepResult {
  username: string;
  queries: string[];
  searchResultCount: number;
  candidates: CandidateProfile[];
  identifiers: DirectIdentifiers;
  identifierSources?: IdentifierSources;
  /** Map: owner-handle (lc) -> evidence that a KNOWN handle appears on that
   * owner's page (a stale cross-reference edge). `target` is the handle that
   * was mentioned (audited username or a discovered seed). `kind:
   * "anchor-rename"` marks the strongest variant: a link whose VISIBLE TEXT is
   * the old handle but whose TARGET (`anchorTarget`) is a different profile
   * root — the signature of a renamed handle. */
  bridgeEvidence?: Record<string, Array<{ url: string; snippet: string; target?: string; kind?: "anchor-rename"; anchorTarget?: string }>>;
  /** Handles/emails that seeded expansion rounds (the snowball trail). */
  snowballSeeds?: string[];
  /** Bridge owner handles: the CURRENT identity discovered via stale
   * cross-references (e.g. github.com/fixturenew links back to fixtureveil → fixturenew
   * is the bridge owner). These are the highest-priority handles for further
   * investigation (GitHub pass, cross-platform search). */
  bridgeOwnerHandles?: string[];
  /** The audited account's own Reddit profile bio, when reachable. */
  redditProfile?: { createdUtc?: number; karma?: number; text: string };
}

/** Dependency-injection seams for the sweep. Defaults hit the real Firecrawl
 *  client; tests inject deterministic fakes so the scoping invariants can be
 *  asserted without network or global module mocking. */
export interface WebSweepDeps {
  search?: (query: string, opts: { limit?: number }) => Promise<FirecrawlSearchResult[]>;
  scrape?: (url: string, opts: { onlyMainContent?: boolean; links?: boolean }) => Promise<ScrapeResult>;
  followSite?: typeof followWebsite;
  redditAbout?: (username: string) => Promise<{ text: string; createdUtc?: number; karma?: number } | null>;
}

/** Is our Firecrawl client usable for a direct sweep? (independent of the LLM) */
export function sweepCapable(): boolean {
  return isFirecrawlConfigured();
}

/** Fixed battery of platform-targeted queries for the audited username. */
function buildQueries(username: string): string[] {
  const q = `"${username}"`;
  const bare = username;
  return [
    `site:github.com ${q}`,
    `site:linkedin.com/in ${q}`,
    `site:x.com ${q}`,
    `site:twitter.com ${q}`,
    `site:instagram.com ${q}`,
    `site:t.me ${q}`,
    `${bare} github`,
    `${bare} infosec OR cybersecurity OR developer`,
    `${q} portfolio OR resume OR cv OR about`,
  ];
}

/** Smaller battery for expansion-round seeds (a discovered handle or email).
 * The current-identity handle is a far richer search target than the decayed
 * audited one — platform accounts, portfolios, and mentions of the REAL person
 * cluster around it. */
function buildSeedQueries(seed: string, kind: "handle" | "email"): string[] {
  if (kind === "email") return [`"${seed}"`];
  const q = `"${seed}"`;
  return [
    `site:github.com ${q}`,
    `${q} portfolio OR about OR contact OR email`,
    `${seed} github OR twitter OR instagram OR linkedin OR telegram`,
  ];
}

/** Aggressive battery for bridge-owner handles — the CURRENT identity discovered
 * via a stale cross-reference (e.g. github.com/fixturenew links back to fixtureveil).
 * These are the highest-value search targets: they are the live, active handle
 * and almost certainly have profiles on mainstream platforms. Search broadly. */
function buildBridgeOwnerQueries(handle: string): string[] {
  const q = `"${handle}"`;
  return [
    `site:github.com ${q}`,
    `site:x.com ${q}`,
    `site:twitter.com ${q}`,
    `site:instagram.com ${q}`,
    `site:linkedin.com/in ${q}`,
    `site:youtube.com ${q}`,
    `site:t.me ${q}`,
    `${q} portfolio OR about OR contact OR email`,
    `${handle} github OR twitter OR instagram OR youtube OR linkedin OR telegram OR tiktok`,
  ];
}

/** Does this search result mention the seed string (case-insensitive, anywhere)? */
function mentionsSeed(
  title: string,
  description: string,
  url: string,
  seed: string,
): boolean {
  const needle = seed.toLowerCase();
  const haystack = `${title} ${description} ${url}`.toLowerCase();
  return haystack.includes(needle);
}

/** Extract up to N short snippets of `text` surrounding each occurrence of
 * `username` (case-insensitive). Uses a WORD-BOUNDARY token match (not a raw
 * substring) so boilerplate URL fragments like `/fixtureveil/i/...` or `id=fixtureveil`
 * don't trigger false bridge detections — only visible, standalone references
 * (badges, inline text, @-mentions) count as a stale-badge signal. */
function extractMentions(text: string, username: string, max = 3): string[] {
  // Match username as a token: preceded by non-alphanumeric-or-@ (start, space,
  // @, quotes, brackets, slash, pipe) and not followed by alphanumeric. This
  // rejects `/fixtureveil/i/`, `?id=fixtureveilx`, etc., but keeps `@fixtureveil`, `[fixtureveil]`,
  // `( fixtureveil )`, `"fixtureveil"`, ` fixtureveil `.
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^\\w@])(${escaped})(?![\\w])`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < max) {
    const matchIdx = m.index + m[1].length;
    const start = Math.max(0, matchIdx - 60);
    const end = Math.min(text.length, matchIdx + username.length + 60);
    const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
    out.push(start > 0 ? `…${snippet}…` : snippet);
  }
  return out;
}

/** Word-boundary mention test over a link's VISIBLE LABEL only. */
function mentionInLabel(label: string, handle: string): boolean {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@])(${escaped})(?![\\w])`, "i").test(label);
}

/**
 * Anchor-rename bridge detection over markdown links: `[fixtureveil](https://x.com/fixturenew)`.
 * The visible label mentions one known handle but the link TARGET is a
 * DIFFERENT profile root. That is not ambient mention — it is the person's
 * own stale cross-reference (renamed handle, old badge). This is the single
 * strongest bridge variant: direction is unambiguous (label = old, target =
 * new). Returns entries with `target` = the labeled (old) handle and
 * `anchorTarget` = the linked (new) handle, deduped and capped.
 */
function extractAnchorBridges(
  text: string,
  knownHandles: string[],
): Array<{ target: string; anchorTarget: string; snippet: string }> {
  const out: Array<{ target: string; anchorTarget: string; snippet: string }> = [];
  const linkRe = /\[([^\]\n]{1,120})\]\(((?:https?:\/\/)[^)\s]+)\)/g;
  for (const m of text.matchAll(linkRe)) {
    const label = m[1].trim();
    const href = m[2].trim();
    const targetHandle = profileRootHandle(href);
    if (!targetHandle) continue;
    for (const h of knownHandles) {
      if (!h || normalizeHandleKey(targetHandle) === normalizeHandleKey(h)) continue;
      if (mentionInLabel(label, h)) {
        out.push({ target: h, anchorTarget: targetHandle, snippet: `[${label}](${href})` });
        break; // one label can be at most one rename edge
      }
    }
    if (out.length >= 4) break;
  }
  return out;
}

/** Link aggregators: pages built purely to enumerate someone's identities.
 * Chased unconditionally — they never mention the audited handle by name. */
const LINK_AGGREGATOR_RE =
  /(^|\.)(linktr\.ee|beacons\.ai|carrd\.co|bio\.link|solo\.to|flow\.page|lnk\.bio|bento\.me|about\.me|allmylinks\.com|hihello\.me)$/i;

/** Big social/dev platforms — scraped via Firecrawl directly (their profile
 * pages render server-side or Firecrawl handles the JS). */
const BIG_PLATFORM_RE =
  /(^|\.)(github\.com|x\.com|twitter\.com|instagram\.com|t\.me|linkedin\.com|facebook\.com|youtube\.com)$/i;

/** Domains that produce commerce/SEO noise (mirror of profileRootHandle). */
const NOISE_HOST_RE =
  /(flipkart|amazon|indiamart|firstsupply|facebook|reddit|steamladder|mudrex|modrinth|coinmarketcap|coingecko|youtube|google|bing|duckduckgo|wikipedia|whatsapp|web\.archive)/;

/** Free-mail providers — a gmail.com domain tells us nothing to follow, but a
 * CUSTOM domain in an email is a site the person owns: chase it. */
const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.in", "yahoo.co.in",
  "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me",
  "aol.com", "zoho.com", "gmx.com", "gmx.net", "rediffmail.com", "yandex.com",
  "mail.com", "qq.com", "163.com", "naver.com", "fastmail.com",
]);

/**
 * Words that must never snowball into SEARCH SEEDS. Extracted "handles" like
 * `github` (the org), `download`, `trending_repos` are platform plumbing, not
 * people — and they are POISONOUS twice over: the search battery wastes
 * queries on them, and a seed named "github" then substring-matches the word
 * GitHub on every scraped page, manufacturing fake bridge edges wholesale.
 * Also excluded as mention targets in bridge detection.
 */
const RESERVED_SEED_WORDS = new Set([
  "github", "gitlab", "git", "twitter", "x", "instagram", "linkedin", "reddit",
  "telegram", "youtube", "discord", "twitch", "medium", "substack", "tiktok",
  "facebook", "threads", "mastodon", "bluesky", "bsky", "snapchat", "pinterest",
  "download", "downloads", "trending", "trending_repos", "explore", "search",
  "login", "signup", "signin", "home", "about", "contact", "blog", "docs",
  "developer", "status", "events", "universe", "help", "support", "settings",
  "notifications", "new", "org", "orgs", "com", "www", "app", "api", "mail",
]);

/** Vendor/system mailbox local parts — never identity seeds (abuse@, dmca@,
 * noreply@ … belong to the SITE we scraped, not to the subject). */
const VENDOR_EMAIL_LOCALPARTS = /^(abuse|dmca|noreply|no-?reply|donotreply|info|support|help|privacy|legal|partners|contact|sales|admin|administrator|webmaster|security|postmaster|marketing|press|media|team|hello|hi|office|mail|billing|trust|safety|copyright|compliance)$/i;

function isSeededHandleWord(handle: string): boolean {
  const norm = normalizeHandleKey(handle);
  return norm.length < 3 || RESERVED_SEED_WORDS.has(norm);
}

function isVendorEmail(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return local.length < 4 || VENDOR_EMAIL_LOCALPARTS.test(local);
}

/**
 * URLs worth scraping: IDENTITY PROFILE ROOTS only. Rejects tweet/status
 * pages, IG reels, search URLs, and e-shop/crypto noise — those pages just
 * link to random unrelated accounts and flood the extractor with false
 * positives. A profile root is github.com/<user>, x.com/<user>, etc.
 */
function profileRootHandle(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split("/").filter(Boolean);

  // github.com/<user>  (NOT /<user>/<repo>, /orgs, /search, /settings, or
  // org/plumbing pages like /gist, /download, /githubuniverse — not people)
  if (/github\.com$/.test(host) && seg.length === 1) {
    const h = seg[0];
    if (!/^(issues|pull|search|trending|trending_repos|marketplace|orgs|topics|collections|notifications|settings|new|features|pricing|enterprise|sponsors|about|login|join|signup|gist|download|downloads|blog|docs|community|events|universe|githubuniverse|nonprofit|mobile|explore)$/i.test(h)) return h;
  }
  // x.com/<user> or twitter.com/<user>  (NOT /status, /search, /home)
  if (/(^|\.)(x\.com|twitter\.com)$/.test(host) && seg.length === 1) {
    const h = seg[0];
    if (!/^(home|search|explore|intent|share|hashtag|notifications|messages|settings|i|compose|login|signup|tos|privacy|about)$/i.test(h)) return h;
  }
  // instagram.com/<user>  (NOT /reel, /p, /explore, /accounts)
  if (/instagram\.com$/.test(host) && seg.length === 1) {
    const h = seg[0];
    if (!/^(p|reel|reels|tv|accounts|explore|stories|about|developer)$/i.test(h)) return h;
  }
  // t.me/<user>  (NOT /s, /joinchat)
  if (/t\.me$/.test(host) && seg.length === 1) {
    const h = seg[0];
    if (!/^(joinchat|s)$/i.test(h)) return h;
  }
  // linkedin.com/in/<user>
  if (/linkedin\.com$/.test(host) && seg.length === 2 && seg[0].toLowerCase() === "in") return seg[1];
  // Link aggregators: linktr.ee/<user>, beacons.ai/<user>, … — an identity
  // directory page; the path segment IS an owner handle for bridge edges.
  if (LINK_AGGREGATOR_RE.test(host)) {
    if (seg.length === 1) return seg[0];
    if (seg.length === 0) return u.hostname.split(".")[0];
  }

  // Personal sites: root or identity-shaped path on a non-noise domain.
  if (!NOISE_HOST_RE.test(host) && !BIG_PLATFORM_RE.test(host)) {
    if (seg.length === 0) return u.hostname.split(".")[0]; // root
    if (/^(about|cv|resume|bio|contact|me|portfolio|profile|info)$/i.test(seg[0])) return u.hostname.split(".")[0];
  }
  return null;
}

function worthScraping(url: string): boolean {
  return profileRootHandle(url) !== null;
}

/** Links on a scraped page worth following as chase candidates: link
 * aggregators always (identity directories), and personal-domain roots —
 * a random follower's github.com/<them> is NOT chased (round-2 seeding catches
 * genuinely-related accounts through the extractor instead). */
function chaseableLinks(links: string[], alreadyKnown: (url: string) => boolean, max = 3): string[] {
  const aggregators: string[] = [];
  const personalSites: string[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    let u: URL;
    try { u = new URL(link); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue; // keeps mailto: out of chasing
    u.hash = "";
    const norm = u.toString().replace(/\/$/, "");
    if (seen.has(norm) || alreadyKnown(link)) continue;
    seen.add(norm);
    if (LINK_AGGREGATOR_RE.test(u.hostname)) aggregators.push(norm);
    else if (!NOISE_HOST_RE.test(u.hostname) && !BIG_PLATFORM_RE.test(u.hostname) && profileRootHandle(norm) !== null) personalSites.push(norm);
  }
  return [...aggregators, ...personalSites].slice(0, max);
}

/** Extract http(s) URLs from stripped page text (site-follower appends a
 * "Links found on page:" block; in-text URLs are fine too). */
function urlsInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    out.add(m[0].replace(/[.,;!?]+$/, ""));
  }
  return [...out];
}

const SWEEP_UA = "osint-ai/2.0 (research; web identity sweep)";

/**
 * The audited account's own Reddit profile bio — people put handles, emails
 * and links in their profile description (and its styled user-subreddit) and
 * forget them. One unauthenticated GET; failure is silent by design.
 * NOTE: reddit.com 403s this endpoint for datacenter/CLI user-agents on many
 * networks — null is the normal outcome there, and the sweep simply skips it.
 */
async function fetchRedditAbout(
  username: string,
): Promise<{ text: string; createdUtc?: number; karma?: number } | null> {
  const url = `https://www.reddit.com/user/${encodeURIComponent(username)}/about.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SWEEP_UA, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json() as any)?.data;
    if (!data) return null;
    const sub = data.subreddit ?? {};
    const parts = [
      `Profile: u/${username}`,
      data.title,
      sub.title,
      sub.public_description,
      sub.description,
      data.description,
    ].filter((x) => typeof x === "string" && String(x).trim());
    const karma =
      (Number(data.link_karma) || 0) + (Number(data.comment_karma) || 0) ||
      (Number(data.total_karma) || 0) || undefined;
    return {
      text: parts.join("\n"),
      createdUtc: Number(data.created_utc) || undefined,
      karma,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface ScrapedPage {
  text: string;
  title: string;
  links: string[];
}

/**
 * Scrape a candidate URL. Big-platform profile pages go through Firecrawl with
 * onlyMainContent:false (their bios live in header/sidebar markup that main-
 * content extraction strips) + the links format. Personal domains go through
 * the site follower first (identity sub-page expansion + mailto: preservation),
 * falling back to Firecrawl for JS-heavy SPAs (linktree etc.).
 */
async function scrapeCandidate(
  url: string,
  scrape: typeof scrapeUrl = scrapeUrl,
  followSite: typeof followWebsite = followWebsite,
): Promise<ScrapedPage | null> {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }

  if (BIG_PLATFORM_RE.test(host) || NOISE_HOST_RE.test(host)) {
    const page = await scrape(url, { onlyMainContent: false, links: true });
    return {
      text: `=== ${url} ===\n${page.title}\n${page.markdown}`,
      title: page.title,
      links: page.links ?? [],
    };
  }

  // Personal site: the follower's <a href> preservation catches emails that
  // never render as visible text; expand identity sub-pages too.
  const site = await followSite(url).catch(() => null);
  if (site?.text && site.text.trim().length > 80) {
    return { text: site.text, title: url, links: urlsInText(site.text) };
  }
  try {
    const page = await scrape(url, { onlyMainContent: false, links: true });
    if (!page.markdown || page.markdown.trim().length < 40) return null;
    return {
      text: `=== ${url} ===\n${page.title}\n${page.markdown}`,
      title: page.title,
      links: page.links ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * Run the deterministic web identity sweep (snowball: username round, then an
 * expansion round seeded by what round 1 found). Errors per-query/per-page are
 * swallowed so one bad fetch never aborts the whole sweep.
 */
export async function runDeterministicWebSweep(
  username: string,
  onProgress?: (msg: string) => void,
  opts: { maxScrapes?: number; maxRounds?: number; deps?: WebSweepDeps } = {},
): Promise<WebSweepResult> {
  const maxScrapes = opts.maxScrapes ?? 25;
  const maxRounds = Math.max(1, opts.maxRounds ?? 2);
  const deps = opts.deps ?? {};
  const doSearch = deps.search ?? searchWeb;
  const doScrape = deps.scrape ?? scrapeUrl;
  const doFollowSite = deps.followSite ?? followWebsite;
  const doRedditAbout = deps.redditAbout ?? fetchRedditAbout;
  // ONLY actually-scraped pages feed deterministic extraction / attribution /
  // snowball seeding. Raw search snippets are excluded: a snippet from an
  // unrelated result that happens to contain an email or profile URL must NOT
  // become an identifier (it has not been read, only indexed). Search results
  // are used solely to SELECT scrape candidates (mentionsSeed) and are
  // counted, never extracted.
  const scrapedPages: Array<{ source: string; text: string }> = [];
  let searchResultsSeen = 0;
  const candidateMap = new Map<string, CandidateProfile>();
  const chaseQueue: CandidateProfile[] = [];
  const queriesFired: string[] = [];
  const snowballSeeds: string[] = [];
  let scrapedCount = 0;

  // ── Phase 0: the audited account's own Reddit profile bio ──
  // (A real fetched page → feeds extraction.)
  let redditProfile: WebSweepResult["redditProfile"];
  const about = await doRedditAbout(username);
  if (about) {
    redditProfile = about;
    scrapedPages.push({ source: `https://www.reddit.com/user/${username}`, text: `=== reddit profile u/${username} ===\n${about.text}` });
    onProgress?.(
      `[web-sweep] Reddit profile bio captured (${about.text.length} chars${about.createdUtc ? `, cake day ${new Date(about.createdUtc * 1000).toISOString().slice(0, 10)}` : ""}).`,
    );
  }

  /** Search-round: fire queries for a seed, collect candidates mentioning it. */
  async function runSearchRound(seed: string, queries: string[]): Promise<void> {
    for (const query of queries) {
      queriesFired.push(query);
      let results: Awaited<ReturnType<typeof searchWeb>> = [];
      try {
        results = await doSearch(query, { limit: 5 });
      } catch (err: any) {
        onProgress?.(`[web-sweep] search failed (${query}): ${err?.message ?? err}`);
        continue;
      }
      for (const r of results) {
        // Count search results for reporting, but do NOT store the snippet
        // text — snippets are not read pages and must not feed extraction.
        if (r?.url) searchResultsSeen++;
        const norm = r.url.replace(/\/$/, "");
        if (
          r.url &&
          mentionsSeed(r.title, r.description, r.url, seed) &&
          worthScraping(r.url) &&
          !candidateMap.has(r.url) &&
          !candidateMap.has(norm)
        ) {
          candidateMap.set(norm, {
            url: norm,
            title: r.title,
            reason: `mentions "${seed}" (search)`,
            scraped: false,
            origin: "search",
          });
        }
      }
    }
  }

  /** Scrape pending candidates + their chased links until the budget is spent. */
  async function scrapeWithBudget(roundSeeds: string[]): Promise<void> {
    // Known handles for generalized bridge detection: the audited username plus
    // every seed that drove a round. A page owned by handle C mentioning any of
    // these is a stale cross-reference edge in the identity graph.
    const knownHandles = [username, ...roundSeeds];

    const scrapeOne = async (c: CandidateProfile): Promise<void> => {
      if (c.scraped || scrapedCount >= maxScrapes) return;
      scrapedCount++;
      c.scraped = true;
      const page = await scrapeCandidate(c.url, doScrape, doFollowSite);
      if (!page) return;
      scrapedPages.push({ source: c.url, text: page.text });
      c.ownerHandle = profileRootHandle(c.url) ?? undefined;

      // Bridge edges against ALL known handles (not just the audited one).
      const ownerLc = c.ownerHandle?.toLowerCase();
      for (const h of knownHandles) {
        if (ownerLc && normalizeHandleKey(c.ownerHandle!) === normalizeHandleKey(h)) continue;
        const mentions = extractMentions(page.text, h);
        if (mentions.length > 0 && c.ownerHandle) {
          c.usernameMentions = [...(c.usernameMentions ?? []), ...mentions].slice(0, 4);
          const key = c.ownerHandle.toLowerCase();
          const entry = bridgeEvidence.get(key) ?? [];
          if (!entry.some((e) => e.url === c.url && e.target === h)) {
            entry.push({ url: c.url, snippet: mentions[0], target: h });
          }
          bridgeEvidence.set(key, entry);
        }
      }

      // Anchor-rename bridges: [old](new) links. Direction is unambiguous —
      // the labeled handle is the stale one, the target is the current one.
      if (c.ownerHandle) {
        for (const ab of extractAnchorBridges(page.text, knownHandles)) {
          const key = c.ownerHandle.toLowerCase();
          const entry = bridgeEvidence.get(key) ?? [];
          if (!entry.some((e) => e.url === c.url && e.target === ab.target && e.kind === "anchor-rename")) {
            entry.push({ url: c.url, snippet: ab.snippet, target: ab.target, kind: "anchor-rename", anchorTarget: ab.anchorTarget });
          }
          bridgeEvidence.set(key, entry);
        }
      }

      // Link chase (primaries only — no recursive crawling). Aggregator pages
      // and personal domains linked from a profile are the owner's own
      // identity directory.
      if (c.origin !== "chase") {
        const chase = chaseableLinks(page.links, (u) => {
          const n = u.replace(/\/$/, "");
          return candidateMap.has(n) || candidateMap.has(u) || chaseQueue.some((x) => x.url === n);
        });
        for (const u of chase) {
          chaseQueue.push({
            url: u,
            title: "(followed from page links)",
            reason: `linked from ${c.url}`,
            scraped: false,
            origin: "chase",
          });
        }
      }
    };

    for (const c of candidateMap.values()) {
      if (c.origin === "chase") continue;
      await scrapeOne(c).catch((err: any) =>
        onProgress?.(`[web-sweep] scrape failed (${c.url}): ${err?.message ?? err}`),
      );
    }
    // Drain the chase queue within the remaining budget.
    let idx = 0;
    while (idx < chaseQueue.length && scrapedCount < maxScrapes) {
      const c = chaseQueue[idx++];
      if (c.scraped) continue;
      await scrapeOne(c).catch(() => undefined);
    }
  }

  /** Pages whose scrape failed get consumed silently; chase items also live in
   * the candidate list at the end (candidateMap + chaseQueue, both kept). */
  const bridgeEvidence = new Map<string, Array<{ url: string; snippet: string; target?: string; kind?: "anchor-rename"; anchorTarget?: string }>>();

  // ── Round 1: the audited username ──
  const round1 = buildQueries(username);
  onProgress?.(`[web-sweep] Round 1: ${round1.length} platform-targeted searches for "${username}"...`);
  await runSearchRound(username, round1);
  onProgress?.(`[web-sweep] Scraping candidates (budget ${maxScrapes}, ${[...candidateMap.values()].length} found so far)...`);
  let seededHandles = new Set([normalizeHandleKey(username)]);
  await scrapeWithBudget([...seededHandles]);

  // ── Round 2: snowball expansion from round-1 discoveries ──
  if (maxRounds > 1) {
    const mid = extractDirectIdentifiers(scrapedPages.map((p) => p.text), username);
    const midRanked = rankHandles(mid.socialHandles, username, Object.fromEntries(bridgeEvidence));
    const newHandleSeeds = midRanked
      .filter((r) => r.tier !== "single platform")
      // Seed hygiene: platform-plumbing words ("github", "download",
      // "trending_repos") are not people — and as mention targets they match
      // the word itself on every page, manufacturing fake bridge edges.
      .filter((r) => !isSeededHandleWord(r.handle))
      .filter((r) => !seededHandles.has(normalizeHandleKey(r.handle)))
      .slice(0, 5)
      .map((r) => r.handle);
    // Vendor/system mailboxes (abuse@, dmca@, info@, …) belong to the sites we
    // scraped, not to the subject — reporting them is fine, seeding on them
    // wastes queries.
    const emailSeeds = mid.emails.filter((e) => !isVendorEmail(e)).slice(0, 3);

    // ── BRIDGE OWNER HANDLES: the highest-value seeds ──
    // When github.com/fixturenew mentions "fixtureveil" (the audited username), the
    // page owner fixturenew is the CURRENT identity — the renamed handle the
    // person actively uses. Search it aggressively across ALL platforms
    // (Instagram, YouTube, X, LinkedIn, …). These are far more valuable than
    // re-searching the stale audited handle.
    const bridgeOwnerSeeds: string[] = [];
    for (const c of candidateMap.values()) {
      if (!c.ownerHandle || !c.usernameMentions || c.usernameMentions.length === 0) continue;
      const ownerNorm = normalizeHandleKey(c.ownerHandle);
      if (
        ownerNorm === normalizeHandleKey(username) ||
        isSeededHandleWord(c.ownerHandle) ||
        seededHandles.has(ownerNorm)
      ) continue;
      bridgeOwnerSeeds.push(c.ownerHandle);
      seededHandles.add(ownerNorm);
    }
    // Also collect bridge owners from the bridgeEvidence map (pages whose
    // owner mentioned a known handle but might not have usernameMentions set).
    for (const [owner] of bridgeEvidence) {
      if (
        owner === normalizeHandleKey(username) ||
        isSeededHandleWord(owner) ||
        seededHandles.has(owner)
      ) continue;
      // Find the original-cased handle from the candidates.
      const matchC = [...candidateMap.values()].find(
        (c) => c.ownerHandle && normalizeHandleKey(c.ownerHandle) === owner,
      );
      const displayHandle = matchC?.ownerHandle ?? owner;
      bridgeOwnerSeeds.push(displayHandle);
      seededHandles.add(owner);
    }
    // Anchor-rename TARGETS are the current identity even when the page is a
    // third party's: [fixtureveil](https://x.com/fixturenew) means fixturenew is the
    // renamed handle regardless of who owns the page containing the link.
    for (const entries of bridgeEvidence.values()) {
      for (const e of entries) {
        const t = e.anchorTarget;
        if (!t || isSeededHandleWord(t)) continue;
        const tNorm = normalizeHandleKey(t);
        if (tNorm === normalizeHandleKey(username) || seededHandles.has(tNorm)) continue;
        if (bridgeOwnerSeeds.some((s) => normalizeHandleKey(s) === tNorm)) continue;
        bridgeOwnerSeeds.push(t);
        seededHandles.add(tNorm);
      }
    }

    // Fire bridge-owner searches FIRST (highest priority — current identity).
    if (bridgeOwnerSeeds.length > 0) {
      onProgress?.(
        `[web-sweep] 🔑 Bridge owner handles discovered (CURRENT identity — highest priority): [${bridgeOwnerSeeds.join(", ")}]`,
      );
      const before = new Set(candidateMap.keys());
      for (const seed of bridgeOwnerSeeds) {
        await runSearchRound(seed, buildBridgeOwnerQueries(seed));
      }
      const fresh = [...candidateMap.keys()].filter((k) => !before.has(k)).length;
      if (fresh > 0) onProgress?.(`[web-sweep] Bridge-owner search found ${fresh} new candidate(s).`);
    }

    if (newHandleSeeds.length > 0 || emailSeeds.length > 0 || bridgeOwnerSeeds.length > 0) {
      snowballSeeds.push(...newHandleSeeds, ...emailSeeds);
      onProgress?.(
        `[web-sweep] Round 2 (snowball): ${bridgeOwnerSeeds.length} bridge-owner(s) + ${newHandleSeeds.length} handle seed(s) [${newHandleSeeds.join(", ")}]${emailSeeds.length > 0 ? ` + ${emailSeeds.length} email seed(s)` : ""}...`,
      );
      const before = new Set(candidateMap.keys());
      for (const seed of newHandleSeeds) {
        await runSearchRound(seed, buildSeedQueries(seed, "handle"));
      }
      for (const email of emailSeeds) {
        await runSearchRound(email, buildSeedQueries(email, "email"));
      }
      const fresh = [...candidateMap.keys()].filter((k) => !before.has(k)).length;
      if (fresh > 0) onProgress?.(`[web-sweep] Snowball found ${fresh} new candidate(s).`);
      for (const s of newHandleSeeds) seededHandles.add(normalizeHandleKey(s));
      // Bridge targets: the audited username + bridge owners + every handle
      // seed (hygiene-filtered — reserved words never become mention targets).
      await scrapeWithBudget([
        username,
        ...bridgeOwnerSeeds,
        ...newHandleSeeds.filter((s) => !isSeededHandleWord(s)),
      ]);
    }

    // Custom-domain emails: each non-free-mail domain is a site the person
    // owns — follow it (budget-shared, counts against maxScrapes).
    const customDomains = [...new Set(
      mid.emails
        .map((e) => e.split("@")[1])
        .filter((d) => d && !FREEMAIL_DOMAINS.has(d)),
    )].slice(0, 3);
    for (const domain of customDomains) {
      if (scrapedCount >= maxScrapes) break;
      const norm = `https://${domain}`.replace(/\/$/, "");
      if (candidateMap.has(norm) || candidateMap.has(`${norm}/`)) continue;
      scrapedCount++;
      onProgress?.(`[web-sweep] Chasing custom email domain: ${domain}`);
      const site = await doFollowSite(`https://${domain}`).catch(() => null);
      if (site?.text && site.text.trim().length > 80) {
        scrapedPages.push({ source: norm, text: site.text });
      }
    }
  }

  // ── Final bridge pass over ALL scraped pages with the COMPLETE known-handle
  // set. Detection at scrape time only knows the seeds discovered so far, so a
  // page scraped in round 1 that links to a handle surfaced in round 2 would
  // be missed. One extra regex sweep is trivial and closes the gap.
  const finalKnown = [username, ...snowballSeeds.filter((s) => !s.includes("@"))].filter((s) => !isSeededHandleWord(s));
  const textByUrl = new Map<string, string>();
  for (const p of scrapedPages) textByUrl.set(p.source.replace(/\/$/, ""), p.text);
  for (const c of [...candidateMap.values(), ...chaseQueue]) {
    if (!c.scraped || !c.ownerHandle) continue;
    const text = textByUrl.get(c.url.replace(/\/$/, ""));
    if (!text) continue;
    for (const h of finalKnown) {
      if (normalizeHandleKey(c.ownerHandle) === normalizeHandleKey(h)) continue;
      const mentions = extractMentions(text, h);
      if (mentions.length === 0) continue;
      c.usernameMentions = [...(c.usernameMentions ?? []), ...mentions].slice(0, 4);
      const key = c.ownerHandle.toLowerCase();
      const entry = bridgeEvidence.get(key) ?? [];
      if (!entry.some((e) => e.url === c.url && e.target === h)) {
        entry.push({ url: c.url, snippet: mentions[0], target: h });
      }
      bridgeEvidence.set(key, entry);
    }
    for (const ab of extractAnchorBridges(text, finalKnown)) {
      const key = c.ownerHandle.toLowerCase();
      const entry = bridgeEvidence.get(key) ?? [];
      if (!entry.some((e) => e.url === c.url && e.target === ab.target && e.kind === "anchor-rename")) {
        entry.push({ url: c.url, snippet: ab.snippet, target: ab.target, kind: "anchor-rename", anchorTarget: ab.anchorTarget });
      }
      bridgeEvidence.set(key, entry);
    }
  }

  // ── Final extraction with per-source attribution (scraped pages only) ──
  const identifiers = extractDirectIdentifiers(scrapedPages.map((p) => p.text), username);
  const identifierSources = attributeSources(scrapedPages, identifiers);

  const candidates = [...candidateMap.values(), ...chaseQueue];
  const scraped = candidates.filter((c) => c.scraped).length;

  // Collect bridge owner handles: pages whose owner is different from the
  // audited username and whose page mentions a known handle (bridge evidence).
  // These are the CURRENT identity handles — the highest-value leads.
  const bridgeOwnerHandles = [...new Set(
    [...bridgeEvidence.keys()]
      .filter((k) => k !== normalizeHandleKey(username) && !isSeededHandleWord(k))
      .map((k) => {
        const matchC = candidates.find(
          (c) => c.ownerHandle && normalizeHandleKey(c.ownerHandle) === k,
        );
        return matchC?.ownerHandle ?? k;
      }),
  )];

  onProgress?.(
    `[web-sweep] ${candidates.length} candidate(s), ${scraped} scraped, ${snowballSeeds.length} snowball seed(s) → ${identifiers.emails.length} email(s), ${identifiers.socialHandles.length} handle(s), ${bridgeEvidence.size} bridge lead(s), ${bridgeOwnerHandles.length} bridge owner(s) [${bridgeOwnerHandles.join(", ") || "none"}].`,
  );

  return {
    username,
    queries: queriesFired,
    searchResultCount: searchResultsSeen,
    candidates,
    identifiers,
    identifierSources,
    bridgeEvidence: Object.fromEntries(
      [...bridgeEvidence.entries()].map(([k, v]) => [k, v]),
    ),
    bridgeOwnerHandles,
    snowballSeeds,
    redditProfile,
  };
}

/** Run the extractor per-page and tag each identifier with the URLs it was
 * seen on — provenance turns a bare value into citable evidence. */
function attributeSources(
  pages: Array<{ source: string; text: string }>,
  identifiers: DirectIdentifiers,
): IdentifierSources {
  const emailSources = new Map<string, Set<string>>();
  const handleSources = new Map<string, Set<string>>();
  for (const page of pages) {
    if (!page.source) continue;
    for (const email of extractEmails(page.text)) {
      const set = emailSources.get(email) ?? new Set<string>();
      if (set.size < 3) set.add(page.source);
      emailSources.set(email, set);
    }
    for (const h of extractSocialHandles(page.text)) {
      const key = `${h.platform}:${h.handle.toLowerCase()}`;
      const set = handleSources.get(key) ?? new Set<string>();
      if (set.size < 3) set.add(page.source);
      handleSources.set(key, set);
    }
  }
  const freemail: Record<string, boolean> = {};
  for (const e of identifiers.emails) {
    freemail[e] = FREEMAIL_DOMAINS.has(e.split("@")[1] ?? "");
  }
  return {
    emails: Object.fromEntries([...emailSources].map(([k, v]) => [k, [...v]])),
    handles: Object.fromEntries([...handleSources].map(([k, v]) => [k, [...v]])),
    freemail,
  };
}

/**
 * Rank handles: a handle string reused across 2+ platforms is the strongest
 * cross-platform identity signal (one person, many sites). Exact username
 * matches come next. Single-platform handles are weakest (often noise from
 * pages that just link to unrelated accounts).
 */
export interface RankedHandle {
  handle: string;
  /** all spelling variants seen (separator drift: john.doe / john_doe / johndoe) */
  variants: string[];
  platforms: string[];
  urls: string[];
  /** number of distinct platforms this handle string appears on */
  platformCount: number;
  /** true if the handle exactly matches the audited username */
  usernameMatch: boolean;
  /** true if a page owned by this handle mentions the audited username
   * (stale-badge bridge: renamed handle still linking to the old one) */
  bridge: boolean;
  /** evidence snippets for the bridge signal, if any. `kind: "anchor-rename"`
   * entries are the strongest variant: the visible link text is the old handle
   * but the link TARGET (`anchorTarget`) is a different profile. */
  bridgeEvidence?: Array<{ url: string; snippet: string; target?: string; kind?: "anchor-rename"; anchorTarget?: string }>;
  /** human-readable rank label */
  tier: "bridge" | "cross-platform cluster" | "username match" | "single platform";
}

/**
 * Rank handles by lead strength. Clustering is SEPARATOR-TOLERANT: handles
 * group by normalizeHandleKey() (john.doe ≈ john_doe ≈ johndoe) because the
 * same person drifts separators across platforms — an exact-string cluster
 * test would split one identity into three "single platform" rows.
 *   1. bridge         — a page owned by this handle mentions the audited username
 *                       (stale badge / renamed handle / forgotten link). The
 *                       single strongest lead type.
 *   2. cluster        — the same normalized handle reused on 2+ platforms.
 *   3. username match — the handle exactly equals the audited username.
 *   4. single         — one platform only (often noise).
 */
export function rankHandles(
  handles: DirectIdentifiers["socialHandles"],
  username: string,
  bridgeEvidence?: Record<string, Array<{ url: string; snippet: string; target?: string }>>,
): RankedHandle[] {
  type Internal = RankedHandle & { rawKeys: string[] };
  const byKey = new Map<string, { ranked: Internal; counts: Map<string, number> }>();
  for (const h of handles) {
    const key = normalizeHandleKey(h.handle);
    if (!key) continue;
    // Platform-owned handles (github.com/github, x.com/telegram, …) are never
    // the subject — they're plumbing scraped from page footers/link lists.
    if (RESERVED_SEED_WORDS.has(key)) continue;
    const rawLc = h.handle.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.ranked.platforms.includes(h.platform)) existing.ranked.platforms.push(h.platform);
      if (!existing.ranked.urls.includes(h.url)) existing.ranked.urls.push(h.url);
      if (!existing.ranked.variants.includes(h.handle)) existing.ranked.variants.push(h.handle);
      if (!existing.ranked.rawKeys.includes(rawLc)) existing.ranked.rawKeys.push(rawLc);
      existing.counts.set(h.handle, (existing.counts.get(h.handle) ?? 0) + 1);
    } else {
      byKey.set(key, {
        ranked: {
          handle: h.handle,
          variants: [h.handle],
          platforms: [h.platform],
          urls: [h.url],
          platformCount: 1,
          usernameMatch: false,
          bridge: false,
          tier: "single platform",
          rawKeys: [rawLc],
        },
        counts: new Map([[h.handle, 1]]),
      });
    }
  }

  const auditedNorm = normalizeHandleKey(username);
  const ranked = [...byKey.values()].map((entry): RankedHandle => {
    const r = entry.ranked;
    // Display handle = the most frequently seen variant.
    let best = r.variants[0];
    let bestCount = -1;
    for (const v of r.variants) {
      const c = entry.counts.get(v) ?? 0;
      if (c > bestCount) { best = v; bestCount = c; }
    }
    r.handle = best;
    r.platformCount = r.platforms.length;
    r.usernameMatch =
      r.rawKeys.includes(username.toLowerCase()) || normalizeHandleKey(best) === auditedNorm;

    const ev = r.rawKeys.flatMap((k) => bridgeEvidence?.[k] ?? []);
    if (ev.length > 0) {
      r.bridge = true;
      r.bridgeEvidence = ev;
      r.tier = "bridge";
    } else if (r.platformCount >= 2) {
      r.tier = "cross-platform cluster";
    } else if (r.usernameMatch) {
      r.tier = "username match";
    } else {
      r.tier = "single platform";
    }
    delete (r as any).rawKeys;
    return r;
  });

  const tierOrder = {
    bridge: 0,
    "cross-platform cluster": 1,
    "username match": 2,
    "single platform": 3,
  } as const;
  ranked.sort(
    (a, b) => tierOrder[a.tier] - tierOrder[b.tier] || b.platformCount - a.platformCount,
  );
  return ranked;
}

/** Render the sweep as a markdown block — LLM-independent, always-on-when-run. */
export function renderWebSweepBlock(result: WebSweepResult): string {
  const di = result.identifiers;
  const hasIds = di.emails.length > 0 || di.socialHandles.length > 0;
  const lines: string[] = [];

  const snowball =
    (result.snowballSeeds?.length ?? 0) > 0
      ? ` Snowball expansion re-seeded with: ${result.snowballSeeds!.map((s) => `\`${s}\``).join(", ")}.`
      : "";
  lines.push(`## Deterministic Web Sweep`);
  lines.push(
    `*LLM-independent search+scrape+extract pass — captures every email/handle reachable from the username, regardless of which path the synthesis agent took. ${result.queries.length} queries, ${result.candidates.length} candidate profile(s), ${result.candidates.filter((c) => c.scraped).length} scraped.${snowball} Every identifier cites the page(s) it was seen on.*`,
  );
  lines.push("");

  if (result.redditProfile?.createdUtc) {
    lines.push(`**Reddit account**: cake day ${new Date(result.redditProfile.createdUtc * 1000).toISOString().slice(0, 10)}${result.redditProfile.karma ? `, ~${result.redditProfile.karma.toLocaleString()} karma` : ""}${result.redditProfile.text.length > 12 ? ` — profile bio captured` : ""}`);
    lines.push("");
  }

  if (hasIds) {
    if (di.emails.length > 0) {
      lines.push(`**Emails found**`);
      for (const e of di.emails) {
        const srcs = result.identifierSources?.emails[e] ?? [];
        const custom = result.identifierSources?.freemail[e] === false ? " — 🌐 custom domain" : "";
        const seen = srcs.length > 0 ? ` — seen on: ${srcs.slice(0, 2).map((s) => `[${shortUrl(s)}](${s})`).join(", ")}` : "";
        lines.push(`- ✉ \`${e}\`${custom}${seen}`);
      }
      lines.push("");
    }
    if (di.socialHandles.length > 0) {
      const ranked = rankHandles(di.socialHandles, result.username, result.bridgeEvidence);
      lines.push(`**Cross-platform handles found** (ranked: bridges → clusters → username → singles)`);
      lines.push("");
      lines.push(`| Tier | Handle | Platforms | URLs | Seen on |`);
      lines.push(`|------|--------|-----------|------|---------|`);
      for (const r of ranked) {
        const badge =
          r.tier === "bridge" ? "🌉 BRIDGE" :
          r.tier === "cross-platform cluster" ? "🔗 CLUSTER" :
          r.tier === "username match" ? "🎯 USERNAME" : "· single";
        const seenOn = [...new Set(
          r.variants.flatMap((v) => r.platforms.map((p) => result.identifierSources?.handles?.[`${p}:${v.toLowerCase()}`] ?? [])).flat(),
        )].slice(0, 2);
        lines.push(
          `| ${badge} | \`${r.handle}\` | ${r.platforms.join(", ")} | ${r.urls.join(" ")} | ${seenOn.map((s) => `[${shortUrl(s)}](${s})`).join(" ") || "—"} |`,
        );
      }
      lines.push("");

      // Cite bridge evidence verbatim — the stale-badge signature.
      const bridges = ranked.filter((r) => r.bridge && r.bridgeEvidence);
      if (bridges.length > 0) {
        lines.push(`**🌉 Bridge leads** — a page owned by this handle mentions the audited username \`${result.username}\` (or another discovered handle). This is the signature of a stale cross-reference (renamed handle, old badge, forgotten link) and the strongest attribution lead. The page owner is the subject's **current/active identity** — search this handle on other platforms.`);
        lines.push("");
        for (const r of bridges) {
          lines.push(`- **\`${r.handle}\`** (${r.platforms.join(", ")}) — **THIS IS THE CURRENT IDENTITY**. Owner page links back to old handle:`);
          for (const ev of r.bridgeEvidence!.slice(0, 2)) {
            if (ev.kind === "anchor-rename") {
              lines.push(`  - [${ev.url}](${ev.url}) — **anchor-rename**: visible link text is \`${ev.target ?? result.username}\` but the link target is \`${ev.anchorTarget}\` — the handle was renamed — _"${ev.snippet}"_`);
            } else {
              lines.push(`  - [${ev.url}](${ev.url}) mentions old handle \`${ev.target ?? result.username}\` — _"${ev.snippet}"_`);
            }
          }
        }
        lines.push("");
      }
    }
  } else {
    lines.push(`*No emails or cross-platform handles extracted from scraped pages.*`);
    lines.push("");
  }

  if (result.candidates.length > 0) {
    lines.push(`**Candidate profiles scraped** (pages mentioning "${result.username}" or a snowball seed)`);
    lines.push("");
    for (const c of result.candidates) {
      const mark = c.scraped ? (c.origin === "chase" ? "🔄" : "📄") : "⏭️";
      lines.push(`- ${mark} [${c.title.slice(0, 60)}](${c.url})`);
    }
    lines.push("");
    lines.push(`*(📄 = search hit, 🔄 = chased from a scraped page's links)*`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Short display form for a URL (host + first path segment). */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const first = u.pathname.split("/").filter(Boolean)[0] ?? "";
    return first && first !== u.hostname ? `${u.hostname}/${first}` : u.hostname;
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * Render the sweep as a GROUND-TRUTH context block for the synthesis/live agent
 * prompt. These leads were extracted deterministically (search+scrape+regex,
 * no LLM) — the model is instructed to treat them as verified anchors to
 * reason about: corroborate by scraping, attribute in the Identity Resolution
 * section, and explain the bridge signal. Returns "" when there are no leads.
 */
export function renderWebContextForPrompt(result: WebSweepResult): string {
  const di = result.identifiers;
  const ranked = rankHandles(di.socialHandles, result.username, result.bridgeEvidence);
  const bridges = ranked.filter((r) => r.bridge);
  const clusters = ranked.filter((r) => r.tier === "cross-platform cluster");
  const usernameMatches = ranked.filter((r) => r.tier === "username match");
  const hasAnything =
    di.emails.length > 0 || bridges.length > 0 || clusters.length > 0 || usernameMatches.length > 0;
  if (!hasAnything) return "";

  const lines: string[] = [];
  lines.push("=== DETERMINISTIC WEB LEADS (GROUND TRUTH — already extracted, do NOT re-discover) ===");
  lines.push("These were found by a deterministic search+scrape+regex pass (no LLM), including a snowball expansion round re-seeded with round-1 discoveries. Treat them as verified facts. REASON about them: corroborate by scraping the URLs, attribute in Identity Resolution, and explain the connections. Do not ignore or contradict them without evidence.");
  lines.push("");

  if (result.redditProfile?.createdUtc) {
    lines.push(`REDDIT ACCOUNT FACTS: cake day ${new Date(result.redditProfile.createdUtc * 1000).toISOString().slice(0, 10)}${result.redditProfile.karma ? `, ~${result.redditProfile.karma} karma` : ""} — use for age-timeline consistency checks.`);
    lines.push("");
  }

  if (di.emails.length > 0) {
    lines.push(`EMAILS FOUND ON SCRAPED PAGES (with provenance):`);
    for (const e of di.emails) {
      const srcs = result.identifierSources?.emails[e] ?? [];
      lines.push(`- \`${e}\`${srcs.length > 0 ? ` — seen on: ${srcs.slice(0, 2).join(", ")}` : ""}`);
    }
    lines.push("An email's local part and domain are themselves query seeds — search the quoted email and visit custom domains.");
    lines.push("");
  }

  if (bridges.length > 0) {
    lines.push("BRIDGE LEADS (HIGHEST PRIORITY) — a page owned by this handle mentions the audited username or another discovered handle. This is the signature of a stale cross-reference (renamed handle, old badge, forgotten link). The PAGE OWNER is likely the subject’s CURRENT/NEW identity — the handle they switched to after renaming. The handle mentioned (the audited username) is the OLD/STALE one. An ANCHOR-RENAME bridge (a link whose visible text is the old handle but whose target is a different profile) is the strongest form — its direction is unambiguous.");
    lines.push("");
    lines.push("KEY INFERENCE: When you see github.com/fixturenew mentioning fixtureveil, it means fixtureveil RENAMED to fixturenew. Search for the NEW handle (fixturenew) on Instagram, YouTube, Twitter, LinkedIn, etc. — that is where their active profiles will be.");
    lines.push("");
    for (const r of bridges) {
      lines.push(`- **${r.handle}** (${r.platforms.join(", ")}) — THIS IS THE CURRENT IDENTITY. Search for \`${r.handle}\` on other platforms.`);
      for (const ev of r.bridgeEvidence!.slice(0, 2)) {
        lines.push(`    URL: ${ev.url}`);
        if (ev.kind === "anchor-rename") {
          lines.push(`    ANCHOR-RENAME (strongest signal, unambiguous direction): the visible link text is "${ev.target ?? result.username}" but the link points to @${ev.anchorTarget} — the handle was renamed FROM ${ev.target ?? result.username} TO ${ev.anchorTarget}. Search ${ev.anchorTarget} everywhere.`);
        } else {
          lines.push(`    mentions OLD handle "${ev.target ?? result.username}" — evidence: "${ev.snippet}"`);
        }
      }
    }
    lines.push("");
  }

  if (clusters.length > 0) {
    lines.push("CROSS-PLATFORM CLUSTERS — the same handle (separator-drift tolerant) reused on 2+ platforms (strong same-person signal):");
    for (const r of clusters.slice(0, 8)) {
      const variants = r.variants.length > 1 ? ` (variants: ${r.variants.join(", ")})` : "";
      lines.push(`- ${r.handle}${variants}: ${r.platforms.join(", ")} — ${r.urls.join(" ")}`);
    }
    lines.push("");
  }

  if (usernameMatches.length > 0) {
    lines.push("EXACT USERNAME MATCHES — accounts whose handle equals the audited username (verify each is the same person, not a namesake):");
    for (const r of usernameMatches.slice(0, 8)) {
      lines.push(`- ${r.handle} (${r.platforms.join(", ")}): ${r.urls.join(" ")}`);
    }
    lines.push("");
  }

  lines.push("=== END DETERMINISTIC LEADS ===");
  lines.push("");
  return lines.join("\n");
}
