/**
 * Deterministic cross-signal corroboration scoring layer.
 *
 * The project's "triangulation" has always lived in two places: `rankHandles`
 * (web-sweep.ts) clusters cross-platform handles, and everything else is a
 * prompt-level suggestion inside the synthesis agent. There is NO deterministic
 * code that counts how many INDEPENDENT sources agree on one entity, boosts
 * cross-domain agreement, penalizes single-source assertions, or flags
 * contradictions.
 *
 * This module is that layer. It fuses five signal sources:
 *   1. `StructuredFindings` — the LLM's findings, each with evidence permalinks
 *      (distinct permalink = independent Reddit source).
 *   2. `DirectIdentifiers` — regex emails + cross-platform handles from the
 *      corpus.
 *   3. `WebSweepResult` — ranked handles with provenance URLs + freemail flags.
 *   4. `GitHubPassResult` — profile fields (name/company/location/email) and
 *      git commit-author identities (real names/emails leaked by git config).
 *   5. `TwitterPassResult` — twitter-cli profile reads (name/bio/location/
 *      website/join date) + follow-graph alt-account candidates, with
 *      reclaimed-handle (squatter) warnings when a handle's account post-dates
 *      the subject's Reddit account.
 *
 * It clusters assertions about the same entity (handle / email / location /
 * employer / real name / age), counts INDEPENDENT sources per cluster, maps the
 * source breakdown to a calibrated low/medium/high confidence, detects
 * contradictions, and produces a 0–100 exposure score + an `overallRisk`
 * ladder that `runAudit` reconciles into the report's headline risk.
 *
 * Purity contract: no fetch, no LLM, no `Date.now()` in the scoring path (the
 * only clock is the injected `now`, defaulting to `new Date()` for callers who
 * want determinism in tests). Every collection is sorted with a total order so
 * output is stable run-to-run. The top-level entry is a total function: any
 * internal throw degrades to `emptyCorroboration()`, mirroring
 * `emptyFindings()` in findings.ts.
 */

import { normalizeHandleKey, type DirectIdentifiers } from "./extract.ts";
import { rankHandles, type WebSweepResult } from "./web-sweep.ts";
import type { GitHubPassResult, GitHubIdentity } from "./github-pass.ts";
import { isReclaimedHandle, type TwitterPassResult } from "./twitter-pass.ts";
import type { StructuredFindings, Finding, FindingCategory } from "./findings.ts";
import { buildVerdict, emptyVerdict, type AuditVerdict } from "./evidence.ts";

/** The entity dimensions we cluster independent signals around. */
export type SignalType =
  | "location"
  | "employer"
  | "real_name"
  | "age"
  | "handle"
  | "email";

/** Confidence buckets — reuse the report-wide vocabulary. */
export type Confidence = "low" | "medium" | "high";

/** Which independent domains contributed to a cluster. Each field counts
 *  DISTINCT sources within that domain (not a boolean). `twitter` is OPTIONAL
 *  (omitted by older call sites/tests — treated as 0) so the fifth domain
 *  rolled in without breaking the four-domain contract. */
export interface SourceBreakdown {
  /** distinct Reddit permalinks across the finding evidence */
  reddit_evidence: number;
  /** distinct web-sweep sources: distinct platforms/URLs for handles,
   *  distinct pages for emails */
  web: number;
  /** distinct GitHub anchors: profile fields + distinct commit repos */
  github: number;
  /** distinct direct-identifier hits (regex emails/handles from the corpus) */
  direct: number;
  /** distinct Twitter anchors: profile reads + alt-account candidates */
  twitter?: number;
}

/** One clustered entity assertion with its corroboration verdict. */
export interface CorroborationCluster {
  /** stable dedupe key: `${signalType}:${normalizedValue}` */
  key: string;
  signalType: SignalType;
  /** canonical display value (e.g. "Hyderabad", "johndoe", "Acme Corp") */
  value: string;
  confidence: Confidence;
  /** total independent corroborating sources across ALL domains */
  independentSources: number;
  /** how many distinct DOMAINS (of the 4) contributed ≥1 source */
  domainCount: number;
  sourceBreakdown: SourceBreakdown;
  /** true when independentSources >= 2 (weak signals triangulated) */
  corroborating: boolean;
  /** verbatim evidence strings/URLs backing the cluster (capped, for render) */
  evidence: string[];
  /** present only when a same-type contradiction was detected */
  contradictions?: string[];
  /** cautionary flags that do NOT downgrade confidence (e.g. a reclaimed
   *  handle whose account post-dates the subject's timeline) */
  warnings?: string[];
  /** handle tier from rankHandles (bridge / cross-platform cluster) — handle clusters only */
  tier?: "bridge" | "cross-platform cluster";
  /** email cluster only: true when the domain is a free-mail provider */
  freemail?: boolean;
}

/** The full corroboration verdict. */
export interface CorroborationResult {
  clusters: CorroborationCluster[];
  /** 0–100 deterministic aggregate exposure score */
  score: number;
  /** mapped from clusters + contradictions to the report enum */
  overallRisk: Confidence;
  /** cross-type contradictions surfaced for the report (e.g. two cities) */
  contradictions: string[];
  /** non-downgrading cautions (e.g. a reclaimed handle whose X account
   *  post-dates the subject's timeline) — advisory, never risk-changing */
  warnings: string[];
  /** the de-overloaded verdict (exposure / attribution / evidence quality).
   *  `overallRisk` is retained as a compatibility projection of
   *  `verdict.exposureSeverity`. */
  verdict: AuditVerdict;
}

/** The bundle of everything the layer fuses — mirrors what `runAudit` holds. */
export interface CorroborationInput {
  username: string;
  structured?: StructuredFindings;
  directIdentifiers?: DirectIdentifiers;
  webSweep?: WebSweepResult;
  gitHub?: GitHubPassResult;
  twitter?: TwitterPassResult;
}

/** Options for deterministic tests (inject a fixed "now" for age math). */
export interface CorroborationOptions {
  now?: Date;
}

/* ────────────────────────────────────────────────────────────────────────
 * Pure normalization helpers (exported for direct unit testing, same pattern
 * as extract.ts's normalizeHandleKey / deobfuscateEmails).
 * ──────────────────────────────────────────────────────────────────────── */

/** Lowercase, trim, collapse whitespace. */
function clean(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Normalize a location value for bucketing: lowercase, trim, and keep the most
 * specific head token before a comma ("Hyderabad, India" → "hyderabad").
 * Display value keeps the original surface form.
 */
export function normalizeLocation(raw: string): string {
  const c = clean(raw);
  // Drop parenthetical qualifiers and everything after the first comma,
  // keeping the most specific place head ("Uppal, Hyderabad, India" → "uppal").
  const head = c.split(/[,(]/)[0] ?? c;
  return head.replace(/^the\s+/, "").trim();
}

/**
 * Normalize an employer value: strip a leading GitHub-style @, trailing
 * corporate suffixes (inc/ltd/llc/corp/pvt ltd), lowercase. "Company" is NOT
 * stripped (it's often part of a real name, e.g. "Boring Company").
 */
export function normalizeEmployer(raw: string): string {
  let c = clean(raw.replace(/^@/, ""));
  c = c.replace(/,\s*(inc|llc|ltd|corp|pvt\s*ltd|gmbh|ag|sa)\b\.?$/i, "");
  c = c.replace(/\s+(inc|llc|ltd|corp|pvt\s*ltd|gmbh|ag|sa)\.?$/i, "");
  return c.trim();
}

/**
 * Normalize a personal name: lowercase, collapse whitespace, strip punctuation
 * that separates name tokens (keeps internal single-letter initials).
 */
export function normalizeName(raw: string): string {
  return clean(raw).replace(/[.,;:!?'"—–-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Tokenize a name for overlap matching: lowercase, drop tokens < 2 chars. */
export function nameTokens(raw: string): string[] {
  const t = normalizeName(raw).split(/\s+/).filter((tok) => tok.length >= 2);
  return [...new Set(t)];
}

/**
 * Parse an age value from a claim string. Returns an integer, a [lo,hi] range,
 * or null when unparseable. Handles "19", "about 19", "19-21", "19 or 20",
 * "mid-20s" (→ 25), "early 20s" (→ 22), "twenties" (→ 25).
 */
export function parseAge(raw: string): number | [number, number] | null {
  const c = raw.toLowerCase();
  const decade =
    c.match(/\b(?:early|mid|late)?\s*(1[0-9]|2[0-9]|3[0-9])s\b/) ??
    c.match(/\b(?:early|mid|late)\s+(?:twenties|thirties|forties|fifties)\b/);
  if (decade) {
    const base = parseInt(decade[1], 10);
    if (!Number.isNaN(base)) {
      if (/early/.test(c)) return base;
      if (/late/.test(c)) return base + 4;
      return base + 2; // mid
    }
  }
  const range = c.match(/\b(\d{1,3})\s*(?:-|to|or|–)\s*(\d{1,3})\b/);
  if (range) {
    const lo = parseInt(range[1], 10);
    const hi = parseInt(range[2], 10);
    if (!Number.isNaN(lo) && !Number.isNaN(hi) && lo <= hi) return [lo, hi];
  }
  const single = c.match(/\b(\d{1,3})\b/);
  if (single) {
    const n = parseInt(single[1], 10);
    if (!Number.isNaN(n) && n > 0 && n < 130) return n;
  }
  return null;
}

/** Bound a number to [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** GitHub-generated emails carry no identity — never cluster them. */
function isContentlessEmail(email: string): boolean {
  return (
    /@users\.noreply\.github\.com$/i.test(email) ||
    /@bots\.noreply\.github\.com$/i.test(email) ||
    /^dependabot\[bot\]@/i.test(email)
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Confidence calibration.
 * ──────────────────────────────────────────────────────────────────────── */

/** Per-domain source caps (prevent one verbose domain from saturating). */
const REDDIT_CAP = 3;
const WEB_CAP = 3;
const GITHUB_CAP = 3;
const DIRECT_CAP = 2;
const TWITTER_CAP = 3;

/**
 * Map a source breakdown to a calibrated confidence. Pure function of the
 * five counts (bonuses that depend on signal type/tier are passed in via
 * `extra` so this stays trivially unit-testable). The `twitter` field is
 * optional — call sites that predate the fifth domain count it as 0.
 *
 *   base            = min(reddit + web + github + direct + twitter, 6)
 *   crossDomainBonus = (domainCount - 1) * 2   (0 when domainCount < 2)
 *   singleSourcePenalty = -2 when total sources <= 1, else 0
 *   s = base + crossDomainBonus + singleSourcePenalty + extra
 *
 *   s >= 6 → high; 3..5 → medium; <= 2 → low
 */
export function calibrateConfidence(
  breakdown: SourceBreakdown,
  extra = 0,
): { confidence: Confidence; independentSources: number; domainCount: number } {
  const reddit = clamp(breakdown.reddit_evidence, 0, REDDIT_CAP);
  const web = clamp(breakdown.web, 0, WEB_CAP);
  const github = clamp(breakdown.github, 0, GITHUB_CAP);
  const direct = clamp(breakdown.direct, 0, DIRECT_CAP);
  const twitter = clamp(breakdown.twitter ?? 0, 0, TWITTER_CAP);

  const independentSources = reddit + web + github + direct + twitter;
  const domainCount =
    (reddit > 0 ? 1 : 0) + (web > 0 ? 1 : 0) + (github > 0 ? 1 : 0) +
    (direct > 0 ? 1 : 0) + (twitter > 0 ? 1 : 0);

  const base = Math.min(independentSources, 6);
  const crossDomainBonus = domainCount >= 2 ? (domainCount - 1) * 2 : 0;
  const singleSourcePenalty = independentSources <= 1 ? -2 : 0;
  const s = base + crossDomainBonus + singleSourcePenalty + extra;

  const confidence: Confidence = s >= 6 ? "high" : s >= 3 ? "medium" : "low";
  return { confidence, independentSources, domainCount };
}

/** Signal types that directly attribute a real person (drive the risk ladder). */
function strongIdentityType(t: SignalType): boolean {
  return t === "real_name" || t === "email" || t === "handle";
}

/* ────────────────────────────────────────────────────────────────────────
 * Contradiction detection + overallRisk ladder.
 * ──────────────────────────────────────────────────────────────────────── */

const CONF_ORDER: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/** Order confidence so "high" is the strongest (low < medium < high). */
export function maxRisk(a: Confidence, b: Confidence): Confidence {
  return CONF_ORDER[a] <= CONF_ORDER[b] ? a : b;
}

/**
 * Deterministic overallRisk ladder from clusters + contradictions.
 *   1. two+ high clusters, OR any high strong-identity cluster → "high"
 *   2. one high, OR two+ medium → "medium"
 *   3. one medium → "medium"
 *   4. else → "low"
 * Contradictions CAP confidence (downgrade one step, never below "low").
 */
export function mapOverallRisk(
  clusters: CorroborationCluster[],
  contradictions: string[],
): Confidence {
  const high = clusters.filter((c) => c.confidence === "high");
  const med = clusters.filter((c) => c.confidence === "medium");
  const strongIdentity = high.some(
    (c) => strongIdentityType(c.signalType) && c.independentSources >= 2,
  );

  let risk: Confidence;
  if (high.length >= 2 || strongIdentity) risk = "high";
  else if (high.length === 1 || med.length >= 2) risk = "medium";
  else if (med.length === 1) risk = "medium";
  else risk = "low";

  // Contradictions in core identity signals cap attribution confidence.
  if (
    contradictions.length > 0 &&
    clusters.some((c) => (c.contradictions?.length ?? 0) > 0)
  ) {
    risk = risk === "high" ? "medium" : risk === "medium" ? "low" : "low";
  }

  return risk;
}

/* ────────────────────────────────────────────────────────────────────────
 * Cluster accumulation.
 * ──────────────────────────────────────────────────────────────────────── */

interface ClusterAccumulator {
  signalType: SignalType;
  /** stable dedupe key */
  key: string;
  /** canonical display value (best-scoring surface form seen) */
  value: string;
  /** domain of the current best display value */
  displayDomain: "reddit" | "web" | "github" | "direct" | "twitter";
  reddit: Set<string>;
  web: Set<string>;
  github: Set<string>;
  direct: Set<string>;
  twitter: Set<string>;
  evidence: string[];
  rawValues: Set<string>;
  /** GitHub anchor string when the account-created date exists (for age check) */
  accountCreated?: string;
  /** handle tier from rankHandles (bridge / cross-platform cluster) */
  tier?: "bridge" | "cross-platform cluster";
}

function isEmptyBreakdown(b: SourceBreakdown): boolean {
  return b.reddit_evidence === 0 && b.web === 0 && b.github === 0 && b.direct === 0 && (b.twitter ?? 0) === 0;
}

/** Add a source identifier to a cluster's domain set (dedup intrinsic). */
function addSource(
  acc: ClusterAccumulator,
  domain: "reddit" | "web" | "github" | "direct" | "twitter",
  id: string,
): void {
  if (!id) return;
  acc[domain].add(id);
}

/* ────────────────────────────────────────────────────────────────────────
 * Main computation.
 * ──────────────────────────────────────────────────────────────────────── */

function normPermalink(permalink: string): string {
  return permalink
    .trim()
    .replace(/\/+$/, "")
    .replace(/^https?:\/\/(www\.)?/i, "")
    .toLowerCase();
}

function finalizeCluster(acc: ClusterAccumulator): CorroborationCluster {
  const breakdown: SourceBreakdown = {
    reddit_evidence: Math.min(acc.reddit.size, REDDIT_CAP),
    web: Math.min(acc.web.size, WEB_CAP),
    github: Math.min(acc.github.size, GITHUB_CAP),
    direct: Math.min(acc.direct.size, DIRECT_CAP),
    twitter: Math.min(acc.twitter.size, TWITTER_CAP),
  };
  const extra = 0;
  const { confidence, independentSources, domainCount } = calibrateConfidence(breakdown, extra);
  const cluster: CorroborationCluster = {
    key: acc.key,
    signalType: acc.signalType,
    value: acc.value,
    confidence,
    independentSources,
    domainCount,
    sourceBreakdown: breakdown,
    corroborating: independentSources >= 2,
    evidence: acc.evidence.slice(0, 3),
  };
  if (acc.tier) cluster.tier = acc.tier;
  return cluster;
}

function computeInner(
  input: CorroborationInput,
  opts: CorroborationOptions,
): CorroborationResult {
  const username = input.username ?? "";
  const now = opts.now ?? new Date();
  const currentYear = now.getUTCFullYear();

  const structured = input.structured;
  const di = input.directIdentifiers;
  const webSweep = input.webSweep;
  const gitHub = input.gitHub;

  /* ── Collect candidate signals into per-type lists ── */
  type Candidate = {
    signalType: SignalType;
    /** normalized bucket value */
    norm: string;
    /** surface display value (longest wins) */
    display: string;
    domain: "reddit" | "web" | "github" | "direct" | "twitter";
    /** source identifier within its domain */
    sourceId: string;
    /** extra evidence string for the cluster */
    evidence: string;
  };

  const candidates: Candidate[] = [];

  // --- Structured findings (Reddit domain, permalinks) ---
  const findings: Finding[] = structured?.findings ?? [];
  for (const f of findings) {
    const cat: FindingCategory = f?.category ?? "other";
    let signalType: SignalType | null = null;
    if (cat === "location") signalType = "location";
    else if (cat === "employer_or_school") signalType = "employer";
    else if (cat === "real_name") signalType = "real_name";
    else if (cat === "age_or_dob") signalType = "age";
    if (!signalType) continue;
    const claim = String(f?.claim ?? "").trim();
    if (!claim) continue;

    const permalinks = (f?.evidence ?? [])
      .map((e) => normPermalink(String(e?.permalink ?? "")))
      .filter(Boolean);
    // Distinct permalinks = independent Reddit sources. A finding with a claim
    // but no permalinks still counts as 1 weak source (never silently vanishes).
    const perms = permalinks.length > 0 ? [...new Set(permalinks)] : [""];
    const norm = normalizeClaimValue(signalType, claim);

    for (const p of perms) {
      candidates.push({
        signalType,
        norm,
        display: claim,
        domain: "reddit",
        sourceId: `permalink:${p}`,
        evidence: p || (f?.evidence?.[0]?.quote ?? ""),
      });
    }
  }

  // --- Direct identifiers (regex, corpus) ---
  for (const h of di?.socialHandles ?? []) {
    const norm = normalizeHandleKey(String(h?.handle ?? ""));
    if (!norm) continue;
    candidates.push({
      signalType: "handle",
      norm,
      display: String(h?.handle ?? norm),
      domain: "direct",
      sourceId: `direct:${h?.platform ?? "?"}:${norm}`,
      evidence: String(h?.url ?? ""),
    });
  }
  for (const e of di?.emails ?? []) {
    const em = String(e ?? "").toLowerCase().trim();
    if (!em || isContentlessEmail(em)) continue;
    candidates.push({
      signalType: "email",
      norm: em,
      display: em,
      domain: "direct",
      sourceId: `direct:email:${em}`,
      evidence: em,
    });
  }

  // --- Web sweep (web domain: provenance URLs / platforms) ---
  const idSources = webSweep?.identifierSources;
  for (const h of webSweep?.identifiers?.socialHandles ?? []) {
    const norm = normalizeHandleKey(String(h?.handle ?? ""));
    if (!norm) continue;
    const key = `${h?.platform ?? "?"}:${norm}`;
    const urls = idSources?.handles?.[key.toLowerCase()] ?? [];
    // Distinct platforms AND distinct page URLs count as web sources (deduped).
    const members = new Set<string>();
    members.add(`platform:${h?.platform ?? "?"}`);
    for (const u of urls.slice(0, 3)) members.add(`url:${u}`);
    for (const m of members) {
      candidates.push({
        signalType: "handle",
        norm,
        display: String(h?.handle ?? norm),
        domain: "web",
        sourceId: `web:${m}`,
        evidence: urls[0] ?? "",
      });
    }
  }
  for (const e of webSweep?.identifiers?.emails ?? []) {
    const em = String(e ?? "").toLowerCase().trim();
    if (!em || isContentlessEmail(em)) continue;
    const urls = idSources?.emails?.[em] ?? [];
    for (const u of urls.slice(0, 3)) {
      candidates.push({
        signalType: "email",
        norm: em,
        display: em,
        domain: "web",
        sourceId: `web:email:${u}`,
        evidence: u,
      });
    }
  }

  // --- GitHub pass (github domain: profile fields + commit repos) ---
  const ghIdentities: GitHubIdentity[] = gitHub?.identities ?? [];
  const ghAnchors = new Map<string, GitHubIdentity>(); // login -> identity
  for (const id of ghIdentities) ghAnchors.set(String(id?.login ?? "").toLowerCase(), id);

  for (const id of ghIdentities) {
    const login = String(id?.login ?? "").toLowerCase();
    if (!login) continue;
    if (id?.location) {
      candidates.push({
        signalType: "location",
        norm: normalizeLocation(id.location),
        display: id.location,
        domain: "github",
        sourceId: `gh:location:${login}`,
        evidence: id.url ?? "",
      });
    }
    if (id?.company) {
      const company = String(id.company).replace(/^@/, "").trim();
      if (!company) continue;
      candidates.push({
        signalType: "employer",
        norm: normalizeEmployer(id.company),
        display: company,
        domain: "github",
        sourceId: `gh:company:${login}`,
        evidence: id.url ?? "",
      });
    }
    if (id?.name) {
      candidates.push({
        signalType: "real_name",
        norm: normalizeName(id.name),
        display: id.name,
        domain: "github",
        sourceId: `gh:name:${login}`,
        evidence: id.url ?? "",
      });
    }
    if (id?.email && !isContentlessEmail(id.email)) {
      candidates.push({
        signalType: "email",
        norm: id.email.toLowerCase().trim(),
        display: id.email,
        domain: "github",
        sourceId: `gh:email:${login}`,
        evidence: id.url ?? "",
      });
    }
    if (id?.twitterUsername) {
      candidates.push({
        signalType: "handle",
        norm: normalizeHandleKey(id.twitterUsername),
        display: id.twitterUsername,
        domain: "github",
        sourceId: `gh:twitter:${login}`,
        evidence: id.url ?? "",
      });
    }
    // The GitHub login itself is a confirmed handle for this account.
    candidates.push({
      signalType: "handle",
      norm: normalizeHandleKey(id.login),
      display: id.login,
      domain: "github",
      sourceId: `gh:login:${login}`,
      evidence: id.url ?? "",
    });
    // Commit-author real names: distinct repos = independent git anchors.
    for (const ca of id?.commitAuthors ?? []) {
      const name = String(ca?.name ?? "").trim();
      if (!name) continue;
      const repo = String(ca?.repo ?? "");
      candidates.push({
        signalType: "real_name",
        norm: normalizeName(name),
        display: name,
        domain: "github",
        sourceId: repo ? `gh:commit:${repo}` : `gh:commit:${login}`,
        evidence: repo ? `https://github.com/${repo}` : "",
      });
    }
  }

  // --- Twitter pass (twitter domain: profile reads + alt-account candidates) ---
  const twitter = input.twitter;
  const twitterHandleCreated = new Map<string, string>(); // norm -> createdAtISO
  for (const r of twitter?.results ?? []) {
    const p = r.profile;
    if (!p) continue;
    const norm = normalizeHandleKey(p.screenName);
    if (norm) {
      twitterHandleCreated.set(norm, p.createdAtISO ?? "");
      candidates.push({
        signalType: "handle",
        norm,
        display: p.screenName,
        domain: "twitter",
        sourceId: `tw:profile:${p.screenName.toLowerCase()}`,
        evidence: `https://x.com/${p.screenName}`,
      });
    }
    // Display name → real_name candidate (multi-token names that don't echo
    // the handle — the "0x handle with an Indian-name display name" signature).
    const name = String(p.name ?? "").trim();
    if (
      /\s/.test(name) &&
      name.split(/\s+/).filter((t) => t.length >= 2).length >= 2 &&
      normalizeHandleKey(name) !== norm
    ) {
      candidates.push({
        signalType: "real_name",
        norm: normalizeName(name),
        display: name,
        domain: "twitter",
        sourceId: `tw:name:${p.screenName.toLowerCase()}`,
        evidence: `https://x.com/${p.screenName}`,
      });
    }
    if (p.location) {
      candidates.push({
        signalType: "location",
        norm: normalizeLocation(p.location),
        display: p.location,
        domain: "twitter",
        sourceId: `tw:location:${p.screenName.toLowerCase()}`,
        evidence: `https://x.com/${p.screenName}`,
      });
    }
    for (const alt of r.altCandidates) {
      const altNorm = normalizeHandleKey(alt.profile.screenName);
      if (!altNorm) continue;
      candidates.push({
        signalType: "handle",
        norm: altNorm,
        display: alt.profile.screenName,
        domain: "twitter",
        sourceId: `tw:alt:${alt.profile.screenName.toLowerCase()}`,
        evidence: `https://x.com/${alt.profile.screenName}`,
      });
      const altName = String(alt.profile.name ?? "").trim();
      if (
        /\s/.test(altName) &&
        altName.split(/\s+/).filter((t) => t.length >= 2).length >= 2 &&
        normalizeHandleKey(altName) !== altNorm
      ) {
        candidates.push({
          signalType: "real_name",
          norm: normalizeName(altName),
          display: altName,
          domain: "twitter",
          sourceId: `tw:altname:${alt.profile.screenName.toLowerCase()}`,
          evidence: `https://x.com/${alt.profile.screenName}`,
        });
      }
    }
  }
  // Emails surfaced by the pass (bios, tweets, followed websites).
  for (const e of twitter?.identifiers?.emails ?? []) {
    if (!e || isContentlessEmail(e)) continue;
    const srcs = twitter?.identifierSources?.emails[e] ?? [];
    if (srcs.length === 0) {
      candidates.push({
        signalType: "email",
        norm: e.toLowerCase().trim(),
        display: e,
        domain: "twitter",
        sourceId: `tw:email:${e}`,
        evidence: e,
      });
      continue;
    }
    for (const u of srcs.slice(0, 3)) {
      candidates.push({
        signalType: "email",
        norm: e.toLowerCase().trim(),
        display: e,
        domain: "twitter",
        sourceId: `tw:email:${u}`,
        evidence: u,
      });
    }
  }

  /* ── Bucket candidates into clusters ── */

  // Exact-keyed clusters: handles + emails.
  const clusters = new Map<string, ClusterAccumulator>();

  const findOrCreate = (
    signalType: SignalType,
    norm: string,
    display: string,
    domain: "reddit" | "web" | "github" | "direct" | "twitter" = "web",
  ): ClusterAccumulator => {
    const key = `${signalType}:${norm}`;
    let acc = clusters.get(key);
    if (!acc) {
      acc = {
        signalType,
        key,
        value: display,
        displayDomain: domain,
        reddit: new Set(),
        web: new Set(),
        github: new Set(),
        direct: new Set(),
        twitter: new Set(),
        evidence: [],
        rawValues: new Set([display]),
      };
      clusters.set(key, acc);
    } else {
      // Prefer typed fields over claim sentences; among equals, the longest.
      if (displayScore(domain, display) > displayScore(acc.displayDomain, acc.value)) {
        acc.value = display;
        acc.displayDomain = domain;
      }
      acc.rawValues.add(display);
    }
    return acc;
  };

  const addToCluster = (
    acc: ClusterAccumulator,
    domain: "reddit" | "web" | "github" | "direct" | "twitter",
    sourceId: string,
    evidence: string,
  ) => {
    addSource(acc, domain, sourceId);
    if (evidence && acc.evidence.length < 3 && !acc.evidence.includes(evidence)) {
      acc.evidence.push(evidence);
    }
  };

  // Handles: reuse rankHandles for canonical clusters + seed hygiene.
  // Build a merged DirectIdentifiers handle list from all handle candidates,
  // then rank it once; attribute each ranked cluster's sources back by
  // membership on normalizeHandleKey.
  const ranked = rankHandles(
    candidates
      .filter((c) => c.signalType === "handle")
      .map((c) => ({ platform: c.domain, handle: c.display, url: c.evidence || "" })),
    username,
    webSweep?.bridgeEvidence,
  );

  const handleSources = new Map<
    string,
    Array<{ domain: "reddit" | "web" | "github" | "direct" | "twitter"; sourceId: string; evidence: string }>
  >();
  for (const c of candidates) {
    if (c.signalType !== "handle") continue;
    const norm = c.norm;
    const arr = handleSources.get(norm) ?? [];
    arr.push({ domain: c.domain, sourceId: c.sourceId, evidence: c.evidence });
    handleSources.set(norm, arr);
  }

  for (const r of ranked) {
    const norm = normalizeHandleKey(r.handle);
    if (!norm || norm === normalizeHandleKey(username)) continue; // drop audited handle
    const acc = findOrCreate("handle", norm, r.handle, "web");
    acc.rawValues = new Set([...acc.rawValues, ...r.variants]);
    for (const s of handleSources.get(norm) ?? []) {
      addToCluster(acc, s.domain, s.sourceId, s.evidence);
    }
    // Bridge / cross-platform cluster tier earns a corroboration bonus.
    if (r.tier === "bridge" || r.tier === "cross-platform cluster") {
      acc.tier = r.tier;
    }
      if (acc.evidence.length === 0) {
      for (const u of r.urls.slice(0, 3)) acc.evidence.push(u);
    }
  }

  // Emails: exact-keyed clusters.
  for (const c of candidates) {
    if (c.signalType !== "email") continue;
    const acc = findOrCreate("email", c.norm, c.display, c.domain);
    addToCluster(acc, c.domain, c.sourceId, c.evidence);
  }

  // Fuzzy clusters: location / employer / real_name / age.
  // Candidates processed in a STABLE sorted order (by norm, then domain) so the
  // greedy containment/token-overlap merge is order-independent run-to-run.
  const fuzzyCandidates = candidates
    .filter((c) => c.signalType !== "handle" && c.signalType !== "email")
    .sort((a, b) => a.norm.localeCompare(b.norm) || a.domain.localeCompare(b.domain));

  for (const c of fuzzyCandidates) {
    // Find an existing cluster whose canonical value contains-or-is-contained.
    let matched: ClusterAccumulator | null = null;
    for (const existing of clusters.values()) {
      if (existing.signalType !== c.signalType) continue;
      if (signalValuesOverlap(c.signalType, existing.value, c.display)) {
        matched = existing;
        break;
      }
    }
    if (!matched) {
      // Only open a new cluster if the norm is meaningful.
      if (!c.norm) continue;
      matched = findOrCreate(c.signalType, c.norm, c.display, c.domain);
    } else {
      // Prefer typed fields over claim sentences; among equals, the longest.
      if (displayScore(c.domain, c.display) > displayScore(matched.displayDomain, matched.value)) {
        matched.value = c.display;
        matched.displayDomain = c.domain;
      }
      matched.rawValues.add(c.display);
    }
    addToCluster(matched, c.domain, c.sourceId, c.evidence);
  }

  // Attach GitHub account-created year to age clusters for contradiction math.
  for (const id of ghIdentities) {
    const login = String(id?.login ?? "").toLowerCase();
    if (!id?.accountCreated) continue;
    for (const acc of clusters.values()) {
      if (acc.signalType === "age" && login) {
        acc.accountCreated ??= id.accountCreated;
      }
    }
  }

  /* ── Finalize + calibrate clusters ── */
  const finalClusters: CorroborationCluster[] = [];
  for (const acc of clusters.values()) {
    const fc = finalizeCluster(acc);
    // Apply signal-type / tier bonuses that depend on context (not in the pure
    // calibrateConfidence function).
    let extra = 0;
    if (fc.signalType === "email" && !isEmptyBreakdown(fc.sourceBreakdown)) {
      const email = acc.value;
      const freemail = webSweep?.identifierSources?.freemail?.[email] ?? true;
      if (!freemail) extra += 1; // custom-domain email: stronger anchor
    }
    if (fc.signalType === "handle") {
      const tier = acc.tier;
      if (tier === "bridge" || tier === "cross-platform cluster") extra += 1;
    }
    if (extra !== 0) {
      const recalced = calibrateConfidence(fc.sourceBreakdown, extra);
      fc.confidence = recalced.confidence;
      fc.independentSources = recalced.independentSources;
      fc.domainCount = recalced.domainCount;
    }
    // Email free-mail flag for renderer + tests.
    if (fc.signalType === "email") {
      fc.freemail = webSweep?.identifierSources?.freemail?.[fc.value] ?? true;
    }
    finalClusters.push(fc);
  }

  /* ── Reclaimed-handle warnings (twitter join date vs subject timeline) ── */
  // A handle whose X account was created well AFTER the subject's Reddit
  // account may have been re-registered by someone else (squatter). These are
  // CAUTIONS, not contradictions — they must never downgrade the risk ladder.
  const warnings: string[] = [];
  const subjectISO = webSweep?.redditProfile?.createdUtc
    ? new Date(webSweep.redditProfile.createdUtc * 1000).toISOString()
    : undefined;
  // The audited-handle cluster is deliberately dropped from the report (it is
  // the input, not a discovery) — but its reclaimed flag is exactly what the
  // analyst needs, so surface it globally.
  const auditedCreated = twitterHandleCreated.get(normalizeHandleKey(username));
  if (auditedCreated && subjectISO && isReclaimedHandle(auditedCreated, subjectISO)) {
    warnings.push(
      `X account for @${username} was created ${auditedCreated.slice(0, 10)} — after the subject's Reddit account; the handle may have been reclaimed by someone else. Verify ownership before attributing.`,
    );
  }
  for (const c of finalClusters) {
    if (c.signalType !== "handle") continue;
    const created = twitterHandleCreated.get(normalizeHandleKey(c.value));
    if (!created || !subjectISO) continue;
    if (isReclaimedHandle(created, subjectISO)) {
      const msg = `X account for @${c.value} was created ${created.slice(0, 10)} — after the subject's Reddit account; the handle may have been reclaimed by someone else. Verify ownership before attributing.`;
      c.warnings = [...(c.warnings ?? []), msg];
    }
  }

  /* ── Contradiction detection ── */
  const contradictions: string[] = [];

  // Intra-type: location / employer / real_name (clusters that didn't merge).
  const byType = (t: SignalType) => finalClusters.filter((c) => c.signalType === t);
  const locationClusters = byType("location");
  if (locationClusters.length >= 2) {
    const pairs: string[] = [];
    for (let i = 0; i < locationClusters.length; i++) {
      for (let j = i + 1; j < locationClusters.length; j++) {
        const a = locationClusters[i];
        const b = locationClusters[j];
        if (a.independentSources >= 1 && b.independentSources >= 1) {
          pairs.push(`${a.value} vs ${b.value}`);
          a.contradictions = [...(a.contradictions ?? []), b.value];
          b.contradictions = [...(b.contradictions ?? []), a.value];
        }
      }
    }
    if (pairs.length > 0) {
      contradictions.push(`Conflicting locations: ${pairs.sort().join("; ")}`);
    }
  }
  const employerClusters = byType("employer");
  if (employerClusters.length >= 2) {
    const pairs: string[] = [];
    for (let i = 0; i < employerClusters.length; i++) {
      for (let j = i + 1; j < employerClusters.length; j++) {
        const a = employerClusters[i];
        const b = employerClusters[j];
        if (a.independentSources >= 2 && b.independentSources >= 2) {
          pairs.push(`${a.value} vs ${b.value}`);
          a.contradictions = [...(a.contradictions ?? []), b.value];
          b.contradictions = [...(b.contradictions ?? []), a.value];
        }
      }
    }
    if (pairs.length > 0) {
      contradictions.push(`Conflicting employers: ${pairs.sort().join("; ")}`);
    }
  }
  const nameClusters = byType("real_name");
  if (nameClusters.length >= 2) {
    const pairs: string[] = [];
    for (let i = 0; i < nameClusters.length; i++) {
      for (let j = i + 1; j < nameClusters.length; j++) {
        const a = nameClusters[i];
        const b = nameClusters[j];
        const aTok = nameTokens(a.value);
        const bTok = nameTokens(b.value);
        const shared = aTok.some((t) => bTok.includes(t));
        if (!shared && a.independentSources >= 1 && b.independentSources >= 1) {
          pairs.push(`${a.value} vs ${b.value}`);
          a.contradictions = [...(a.contradictions ?? []), b.value];
          b.contradictions = [...(b.contradictions ?? []), a.value];
        }
      }
    }
    if (pairs.length > 0) {
      contradictions.push(`Conflicting real names: ${pairs.sort().join("; ")}`);
    }
  }

  // Cross-type: age vs GitHub account-open age.
  for (const ageCl of byType("age")) {
    const parsed = parseAge(ageCl.value);
    if (!parsed) continue;
    const age = typeof parsed === "number" ? parsed : Math.round((parsed[0] + parsed[1]) / 2);
    for (const id of ghIdentities) {
      const created = String(id?.accountCreated ?? "");
      const yearMatch = created.match(/^(\d{4})/);
      if (!yearMatch) continue;
      const createdYear = parseInt(yearMatch[1], 10);
      if (createdYear <= 0) continue;
      const openAge = age - (currentYear - createdYear);
      if (openAge < 8 || age < 10 || age > 100) {
        contradictions.push(
          `Age estimate (${age}) inconsistent with GitHub account created ${createdYear}`,
        );
        ageCl.contradictions = [...(ageCl.contradictions ?? []), `GitHub account created ${createdYear}`];
      }
    }
  }

  // Dedupe contradictions (stable).
  const uniqueContradictions = [...new Set(contradictions)].sort();

  /* ── Score (0–100 advisory exposure gauge) ── */
  let score = 0;
  for (const c of finalClusters) {
    const baseWeight =
      c.confidence === "high" ? 22 : c.confidence === "medium" ? 12 : 4;
    const identityMult = strongIdentityType(c.signalType) ? 1.3 : 1.0;
    const contradPenalty = (c.contradictions?.length ?? 0) > 0 ? 4 : 0;
    score += baseWeight * identityMult - contradPenalty;
  }
  score = clamp(Math.round(score), 0, 100);

  const overallRisk = mapOverallRisk(finalClusters, uniqueContradictions);

  const verdict = buildVerdict({
    overallRisk,
    clusters: finalClusters,
    contradictionStrings: uniqueContradictions,
    evidenceValidation: structured?.evidenceValidation,
  });

  return {
    clusters: finalClusters.sort(
      (a, b) =>
        CONF_ORDER[a.confidence] - CONF_ORDER[b.confidence] ||
        b.independentSources - a.independentSources ||
        a.key.localeCompare(b.key),
    ),
    score,
    overallRisk,
    contradictions: uniqueContradictions,
    warnings: [...new Set(warnings)].sort(),
    verdict,
  };
}

/** Containment / token-overlap predicate for fuzzy cluster merging. */
function signalValuesOverlap(
  signalType: SignalType,
  existingValue: string,
  newValue: string,
): boolean {
  if (!existingValue || !newValue) return false;
  switch (signalType) {
    case "location": {
      const a = normalizeLocation(existingValue);
      const b = normalizeLocation(newValue);
      return a === b || a.includes(b) || b.includes(a);
    }
    case "employer": {
      const a = normalizeEmployer(existingValue);
      const b = normalizeEmployer(newValue);
      return a === b || a.includes(b) || b.includes(a);
    }
    case "real_name": {
      const a = nameTokens(existingValue);
      const b = nameTokens(newValue);
      if (a.length === 0 || b.length === 0) return false;
      const shared = a.filter((t) => b.includes(t));
      // ≥2 shared tokens, or a single ≥3-char token shared (fits "John Doe"
      // + "John A. Doe" and a lone surname match).
      return shared.length >= 2 || (shared.length === 1 && shared[0].length >= 3);
    }
    case "age": {
      const pa = parseAge(existingValue);
      const pb = parseAge(newValue);
      if (!pa || !pb) return false;
      const ra = typeof pa === "number" ? [pa, pa] : pa;
      const rb = typeof pb === "number" ? [pb, pb] : pb;
      return ra[0] <= rb[1] && rb[0] <= ra[1];
    }
    default:
      return false;
  }
}

/** Display-value preference: typed entity fields (GitHub/web/twitter/direct)
 * beat verbose LLM claim sentences; among equals, longer (more specific)
 * wins. */
function displayScore(domain: "reddit" | "web" | "github" | "direct" | "twitter", display: string): number {
  const isClaim = domain === "reddit";
  return (isClaim ? 0 : 1) * 1000 + (isClaim ? -display.length : display.length);
}

/** Normalize a claim string into a bucket value by signal type. */
function normalizeClaimValue(signalType: SignalType, claim: string): string {
  switch (signalType) {
    case "location":
      return normalizeLocation(claim);
    case "employer":
      return normalizeEmployer(claim);
    case "real_name":
      return normalizeName(claim);
    case "age":
      return claim.trim().toLowerCase();
    default:
      return claim.trim().toLowerCase();
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Empty result + total-function entry.
 * ──────────────────────────────────────────────────────────────────────── */

function emptyCorroboration(): CorroborationResult {
  return { clusters: [], score: 0, overallRisk: "low", contradictions: [], warnings: [], verdict: emptyVerdict() };
}

/**
 * Top-level entry. Pure, never throws — wraps computeInner in try/catch and
 * returns emptyCorroboration() on any failure.
 */
export function computeCorroboration(
  input: CorroborationInput,
  opts: CorroborationOptions = {},
): CorroborationResult {
  try {
    return computeInner(input, opts);
  } catch {
    return emptyCorroboration();
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Markdown renderer (style-matched to renderWebSweepBlock/renderGitHubBlock).
 * ──────────────────────────────────────────────────────────────────────── */

const CONF_BADGE: Record<Confidence, string> = {
  high: "🔴 HIGH",
  medium: "🟡 MEDIUM",
  low: "⚪ LOW",
};

const RISK_BADGE: Record<Confidence, string> = {
  high: "🔴 HIGH",
  medium: "🟡 MEDIUM",
  low: "🟢 LOW",
};

const SIGNAL_LABEL: Record<SignalType, string> = {
  location: "location",
  employer: "employer",
  real_name: "real name",
  age: "age",
  handle: "handle",
  email: "email",
};

/** Render the corroboration result as a "## Cross-Signal Corroboration" block. */
export function renderCorroborationBlock(result: CorroborationResult): string {
  if (result.clusters.length === 0 && result.warnings.length === 0) return "";
  const lines: string[] = [];
  lines.push(`## Cross-Signal Corroboration`);
  lines.push("");
  lines.push(
    `*Deterministic fusion pass (no LLM) — clusters independent signals that assert the same entity, counts corroborating sources across Reddit evidence, the web sweep, the GitHub pass, the Twitter pass, and regex identifiers, and emits calibrated confidence. ${result.clusters.length} cluster(s), ${result.contradictions.length} contradiction(s). Overall corroborated risk: ${RISK_BADGE[result.overallRisk]}. Exposure score: ${result.score}/100.*`,
  );
  lines.push("");

  const v = result.verdict;
  lines.push(
    `**Verdict** — exposure severity: **${v.exposureSeverity}** · attribution confidence: **${v.attributionConfidence}** · evidence quality: **${v.evidenceQuality}**`,
  );
  lines.push("");

  if (result.clusters.length > 0) {
    lines.push(`**Corroborated entities** (ranked: high → low confidence, then by source count)`);
    lines.push("");
    lines.push(`| Confidence | Type | Value | Sources | Domains | Breakdown | Flags |`);
    lines.push(`|------------|------|-------|---------|---------|-----------|-------|`);

    const sorted = [...result.clusters].sort(
      (a, b) =>
        CONF_ORDER[a.confidence] - CONF_ORDER[b.confidence] ||
        b.independentSources - a.independentSources ||
        a.key.localeCompare(b.key),
    );

    for (const c of sorted) {
      const breakdownParts: string[] = [];
      if (c.sourceBreakdown.reddit_evidence > 0) breakdownParts.push(`reddit ${c.sourceBreakdown.reddit_evidence}`);
      if (c.sourceBreakdown.web > 0) breakdownParts.push(`web ${c.sourceBreakdown.web}`);
      if (c.sourceBreakdown.github > 0) breakdownParts.push(`github ${c.sourceBreakdown.github}`);
      if (c.sourceBreakdown.direct > 0) breakdownParts.push(`direct ${c.sourceBreakdown.direct}`);
      if ((c.sourceBreakdown.twitter ?? 0) > 0) breakdownParts.push(`twitter ${c.sourceBreakdown.twitter}`);

      const flags: string[] = [];
      if ((c.contradictions?.length ?? 0) > 0) {
        flags.push(`⚠️ conflict: ${c.contradictions![0]}`);
      }
      if ((c.warnings?.length ?? 0) > 0) {
        flags.push(`⚠️ ${c.warnings![0]}`);
      }
      if (c.signalType === "handle") {
        if (c.tier === "bridge") flags.push("🌉 bridge");
        else if (c.tier === "cross-platform cluster") flags.push("🔗 cluster");
      }
      if (c.signalType === "email" && !isEmptyBreakdown(c.sourceBreakdown)) {
        if (c.freemail === false) flags.push("🌐 custom domain");
      }
      if (!c.corroborating) flags.push("single-source");

      const val = c.value.length > 60 ? `${c.value.slice(0, 57)}…` : c.value;
      lines.push(
        `| ${CONF_BADGE[c.confidence]} | ${SIGNAL_LABEL[c.signalType]} | \`${val}\` | ${c.independentSources} | ${c.domainCount} | ${breakdownParts.join(" · ") || "—"} | ${flags.join(", ") || "—"} |`,
      );
    }
  }

  if (result.contradictions.length > 0) {
    lines.push("");
    lines.push(`**⚠️ Contradictions**`);
    for (const c of result.contradictions) lines.push(`- ${c}`);
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push(`**⚠️ Warnings** (cautions only — do not affect the risk score)`);
    for (const w of result.warnings) lines.push(`- ${w}`);
  }

  return lines.join("\n");
}
