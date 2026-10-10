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
 * When supplied, the identity graph partitions observations by person before
 * clustering. Separate persons remain inspectable but never affect the
 * subject's score/verdict; graph-backed email local-part joins earn a small
 * confidence bonus, not another independent observation.
 *
 * Purity contract: no fetch, no LLM, no `Date.now()` in the scoring path (the
 * only clock is the injected `now`, defaulting to `new Date()` for callers who
 * want determinism in tests). Every collection is sorted with a total order so
 * output is stable run-to-run. The top-level entry is a total function: any
 * internal throw degrades to `emptyCorroboration()`, mirroring
 * `emptyFindings()` in findings.ts.
 */

import { normalizeHandleKey, type DirectIdentifiers } from "./extract.ts";
import { profileRootHandle, rankHandles, type WebSweepResult } from "./web-sweep.ts";
import type { GitHubPassResult, GitHubIdentity } from "./github-pass.ts";
import { isReclaimedHandle, nameLooksReal, type TwitterPassResult } from "./twitter-pass.ts";
import type { AccountStatus, StructuredFindings, Finding, FindingCategory } from "./findings.ts";
import { canonicalSourceUrl, buildVerdict, emptyVerdict, type AuditVerdict } from "./evidence.ts";
import type { IdentityGraph, PersonEntity } from "./identity-graph.ts";
import type { Candidate } from "../types.ts";

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

/** Which originating domains contributed to a cluster. Each field counts
 *  DISTINCT documents within that domain (not collectors). `twitter` is OPTIONAL
 *  (omitted by older call sites/tests — treated as 0) so the fifth domain
 *  rolled in without breaking the four-domain contract. */
export interface SourceBreakdown {
  /** distinct Reddit permalinks across the finding evidence */
  reddit_evidence: number;
  /** distinct web documents (excluding Reddit/GitHub/X origins) */
  web: number;
  /** distinct GitHub profiles and commit documents */
  github: number;
  /** distinct direct-identifier hits (regex emails/handles from the corpus) */
  direct: number;
  /** distinct X profile and tweet documents */
  twitter?: number;
}

/** One clustered entity assertion with its corroboration verdict. */
export interface CorroborationCluster {
  /** stable dedupe key, prefixed by person id when graph ownership is known */
  key: string;
  signalType: SignalType;
  /** Graph ownership; absent for unconnected leads or graph-free callers. */
  personId?: string;
  /** False means a separate person: excluded from the subject's verdict. */
  isSubject?: boolean;
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
  accountStatus?: AccountStatus;
  /** present only when a same-type contradiction was detected */
  contradictions?: string[];
  /** cautionary flags that do NOT downgrade confidence (e.g. a reclaimed
   *  handle whose account post-dates the subject's timeline) */
  warnings?: string[];
  /** handle tier from rankHandles (bridge / cross-platform cluster) — handle clusters only */
  tier?: "bridge" | "cross-platform cluster";
  /** email cluster only: true when the domain is a free-mail provider */
  freemail?: boolean;
  /** Email local-part matches a handle joined to it in the subject graph. */
  emailLocalPartMatch?: boolean;
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
  /** Accounts a model REJECTED label removed, with everything read off them
   *  (`handle (url)`) — surfaced so a wrong label never drops evidence silently. */
  rejectedAccounts: string[];
}

/** The bundle of everything the layer fuses — mirrors what `runAudit` holds. */
export interface CorroborationInput {
  username: string;
  /** Full post-corpus graph, including disclosure edges, before scoring. */
  identityGraph?: IdentityGraph;
  structured?: StructuredFindings;
  directIdentifiers?: DirectIdentifiers;
  webSweep?: WebSweepResult;
  gitHub?: GitHubPassResult;
  twitter?: TwitterPassResult;
  /** Raw pre-filter Reddit item texts (+ their permalinks). The corpus
   *  URL-extractor only matches full profile URLs, so a VERBAL handle
   *  disclosure ("my discord is xyz42", no URL) never becomes an observation.
   *  We scan these texts for word-boundary mentions of clustered handles and
   *  credit each mentioning text as one reddit-domain source — a handle the
   *  subject disclosed on Reddit must not register as web-only. */
  corpusTexts?: Array<{ text: string; permalink?: string }>;
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

export interface CandidateHypothesisCheck {
  name: string;
  status: "CONSISTENT" | "INCONCLUSIVE" | "CONFLICTING";
  matches: Pick<CorroborationCluster, "value" | "evidence">[];
  conflicts: Pick<CorroborationCluster, "value" | "evidence">[];
}

/** Test `--subject-name` against medium/high-confidence, subject-owned name
 *  clusters. Read-only: never adds weight or changes the verdict. */
export function checkCandidateHypothesis(
  candidate?: Candidate,
  corroboration?: CorroborationResult,
): CandidateHypothesisCheck | undefined {
  const name = candidate?.name?.trim();
  if (!name) return undefined;
  const tokens = nameTokens(name);
  const names = (corroboration?.clusters ?? []).filter((c) =>
    c.signalType === "real_name" && c.isSubject === true && c.confidence !== "low" && nameTokens(c.value).length >= 2);
  const shared = (c: CorroborationCluster) => nameTokens(c.value).filter((t) => tokens.includes(t)).length;
  // A surname alone is not agreement; middle names and token order may vary.
  const matches = tokens.length < 2 ? [] : names.filter((c) =>
    shared(c) >= 2 && shared(c) === Math.min(tokens.length, nameTokens(c.value).length));
  const conflicts = tokens.length < 2 ? [] : names.filter((c) => shared(c) === 0);
  const partial = names.some((c) => shared(c) > 0 && !matches.includes(c));
  const status = matches.length > 0 && conflicts.length === 0 && !partial ? "CONSISTENT" :
    matches.length === 0 && conflicts.length > 0 && !partial ? "CONFLICTING" : "INCONCLUSIVE";
  const project = (c: CorroborationCluster) => ({ value: c.value, evidence: [...c.evidence] });
  return {
    name,
    status,
    matches: matches.map(project),
    conflicts: conflicts.map(project),
  };
}

export function renderCandidateHypothesisBlock(check?: CandidateHypothesisCheck): string {
  if (!check) return "";
  const lines = [
    "## Deterministic Candidate Hypothesis Check",
    "",
    `Candidate: **${check.name}** — **${check.status}**.`,
    "",
    "Only medium/high-confidence, subject-owned name evidence counts. Agreement requires at least two shared name tokens; partial matches remain inconclusive. This checks consistency, not identity proof, and does not change the exposure score.",
    "",
  ];
  for (const [label, entries] of [["Matching name", check.matches], ["Conflicting name", check.conflicts]] as const) {
    for (const entry of entries) {
      lines.push(`- ${label}: **${entry.value}** — ${entry.evidence.map((url) => `[source](${url})`).join(", ")}`);
    }
  }
  if (check.matches.length === 0 && check.conflicts.length === 0) {
    lines.push("No sufficient subject-owned name evidence matched or refuted the candidate.");
  }
  return lines.join("\n");
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
 * `floor` (the identity-graph exposure floor) raises the ladder result first;
 * contradictions then CAP it (downgrade one step, never below "low").
 */
export function mapOverallRisk(
  clusters: CorroborationCluster[],
  contradictions: string[],
  floor: Confidence = "low",
): Confidence {
  clusters = clusters.filter((c) => c.isSubject !== false);
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
  risk = maxRisk(risk, floor);

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
  person?: PersonEntity;
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
  return canonicalSourceUrl(permalink) || permalink.trim();
}

/**
 * Word-boundary mention test for a handle spelling in free text — mirrors
 * web-sweep.ts's extractMentions (not exported, so re-implemented locally).
 * The preceding-char class excludes URL separators (`/ = & ?`) on TOP of the
 * word-boundary rule, so a handle inside a path/query fragment
 * (`/xyz42/i/`, `?id=xyz42`) does NOT count, while `@xyz42`, `[xyz42]`,
 * `"xyz42"` and bare ` xyz42 ` do. The trailing lookahead rejects run-ons
 * (`?id=xyz42abc`).
 */
function mentionsHandleToken(text: string, handle: string): boolean {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w/=&?])(${escaped})(?![\\w])`, "i").test(text);
}

/** Short verbatim snippet around the first occurrence of `handle` — evidence
 *  for corpus-mention sources that have no permalink. */
function mentionSnippet(text: string, handle: string): string {
  const idx = text.toLowerCase().indexOf(handle.toLowerCase());
  if (idx < 0) return text.slice(0, 120);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + handle.length + 40);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
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
  if (acc.person) {
    cluster.personId = acc.person.id;
    cluster.isSubject = acc.person.isSubject;
  }
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
  const accounts = structured?.accounts ?? [];
  const statusOf = (handle: string) =>
    accounts.find((a) => normalizeHandleKey(a.handle) === normalizeHandleKey(handle))?.status;
  const di = input.directIdentifiers;
  const webSweep = input.webSweep;
  const gitHub = input.gitHub;
  const graph = input.identityGraph;
  const personByNode = new Map<string, PersonEntity>();
  for (const person of graph?.persons ?? []) {
    for (const id of [...person.handleNodes, ...person.emailNodes, ...person.nameNodes]) {
      personByNode.set(id, person);
    }
  }
  const subject = graph?.persons.find((p) => p.isSubject);
  // A same-username account the graph split off as a namesake lives at
  // `handle:<key>@<platform>`; prefer it so its fields never score for the subject.
  const handleNodeId = (handle: string, platform?: string) => {
    const id = `handle:${normalizeHandleKey(handle)}`;
    return platform && personByNode.has(`${id}@${platform}`) ? `${id}@${platform}` : id;
  };
  const personForHandle = (handle: string, platform?: string) => personByNode.get(handleNodeId(handle, platform));
  const nodeById = new Map(graph?.nodes.map((n) => [n.id, n]) ?? []);
  const ownedSites = (graph?.edges ?? []).filter((e) => e.kind === "site-of")
    .flatMap((e) => {
      const person = personByNode.get(e.from);
      const site = nodeById.get(e.to);
      return person && site ? [{ person, source: normPermalink(site.value) }] : [];
    });
  const personForSource = (source: string): PersonEntity | null | undefined => {
    // A personal site's domain need not resemble its owner's handle. Site
    // edges do not merge persons, but they DO identify the owner of a page.
    const url = normPermalink(source);
    const owners = new Map(ownedSites
      .filter((s) => url === s.source || url.startsWith(`${s.source}/`))
      .map((s) => [s.person.id, s.person]));
    if (owners.size > 0) return owners.size === 1 ? [...owners.values()][0] : null;
    const handle = profileRootHandle(/^https?:\/\//i.test(source) ? source : `https://${source}`);
    const host = url.startsWith("https://x.com/") ? "x" : url.startsWith("https://github.com/") ? "github" : undefined;
    return handle ? personForHandle(handle, host) : undefined;
  };

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
    /** Explicit account owner, especially for commits in someone else's repo. */
    ownerNode?: string;
    person?: PersonEntity;
    /** REAL platform for handle candidates (e.g. "github", "x", "discord") —
     *  NOT the pipe it arrived through. Feeds rankHandles so the cluster-tier
     *  bonus reflects platform diversity; `domain` remains the pipe for the
     *  source breakdown. */
    platform?: string;
  };

  let candidates: Candidate[] = [];

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
    // A claim without captured provenance has zero weight.
    const perms = permalinks.length > 0 ? [...new Set(permalinks)] : [];
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
      platform: String(h?.platform ?? "?"),
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
    // Platforms describe accounts, not independent source observations.
    // An empty source preserves the lead without giving it evidence weight.
    for (const url of new Set(urls.length ? urls.slice(0, 3) : [""])) {
      candidates.push({
        signalType: "handle",
        norm,
        display: String(h?.handle ?? norm),
        domain: "web",
        sourceId: url ? `web:url:${url}` : "",
        evidence: url,
        platform: String(h?.platform ?? "?"),
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
    const start = candidates.length;
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
    if (id?.name && nameLooksReal(id.name)) {
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
        platform: "x",
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
      platform: "github",
    });
    // Commit-author real names: distinct repos = independent git anchors.
    for (const ca of id?.commitAuthors ?? []) {
      const name = String(ca?.name ?? "").trim();
      if (!nameLooksReal(name)) continue;
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
    for (const c of candidates.slice(start)) c.ownerNode = handleNodeId(login, "github");
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
        platform: "x",
      });
    }
    // Display name → real_name candidate (multi-token names that don't echo
    // the handle — the "0x handle with an Indian-name display name" signature).
    const name = String(p.name ?? "").trim();
    if (nameLooksReal(name, p.screenName)) {
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
        platform: "x",
      });
      const altName = String(alt.profile.name ?? "").trim();
      if (nameLooksReal(altName, alt.profile.screenName)) {
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

  // A REJECTED label drops that account and everything read off its profile,
  // unless deterministic graph ownership says it is the subject's.
  const rejected = accounts.filter((a) => a.status === "REJECTED" && !personForHandle(a.handle)?.isSubject);
  const removedBy = (a: (typeof accounts)[number], c: Candidate) =>
    (c.signalType === "handle" && c.norm === normalizeHandleKey(a.handle)) ||
    (!!canonicalSourceUrl(a.url) && canonicalSourceUrl(a.url) === canonicalSourceUrl(c.evidence));
  const rejectedAccounts = rejected.filter((a) => candidates.some((c) => removedBy(a, c)))
    .map((a) => (a.url ? `${a.handle} (${a.url})` : a.handle));
  candidates = candidates.filter((c) => !rejected.some((a) => removedBy(a, c)));

  // Attribute the observation's OWNER before its value: a namesake's profile
  // may mention a subject identifier, and that mention must not strengthen
  // the subject. Unknown leads retain legacy behavior, without person fusion.
  for (const c of candidates) {
    const nodeId = c.signalType === "handle" ? `handle:${c.norm}` :
      c.signalType === "email" ? `email:${c.norm}` : undefined;
    const owner = c.ownerNode ? personByNode.get(c.ownerNode) : personForSource(c.evidence);
    // A shared site's ambiguous ownership must not fall back to the subject
    // merely because the page repeats a subject identifier.
    c.person = owner === null ? undefined : owner ?? (nodeId ? personByNode.get(nodeId) : undefined);
    if (owner !== null && !c.person && c.domain === "reddit") c.person = subject;
  }

  /* ── Bucket candidates into clusters ── */

  // Exact-keyed clusters: handles + emails.
  const clusters = new Map<string, ClusterAccumulator>();

  const findOrCreate = (
    signalType: SignalType,
    norm: string,
    display: string,
    domain: "reddit" | "web" | "github" | "direct" | "twitter" = "web",
    person?: PersonEntity,
  ): ClusterAccumulator => {
    const key = `${person ? `${person.id}|` : ""}${signalType}:${norm}`;
    let acc = clusters.get(key);
    if (!acc) {
      acc = {
        signalType,
        person,
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
    // One originating document counts once, under the domain it lives on,
    // no matter which collector read it.
    const url = domain === "direct" ? "" : canonicalSourceUrl(evidence);
    const host = url ? new URL(url).hostname : "";
    const origin = host === "reddit.com" ? "reddit" : host === "github.com" ? "github" : host === "x.com" ? "twitter" : domain;
    addSource(acc, origin, url || sourceId);
    if (evidence && acc.evidence.length < 3 && !acc.evidence.includes(evidence)) {
      acc.evidence.push(evidence);
    }
  };

  // Handles: reuse rankHandles for canonical clusters + seed hygiene.
  // Rank each person's handle candidates separately; attribute sources back
  // by normalized variant membership without pooling different people.
  // Platform de-conflation: `platform` carries the REAL platform (github, x,
  // discord, …), never the arrival pipe — a handle scraped on github.com via
  // the web sweep AND read via the GitHub REST API is ONE platform through two
  // pipes and must not earn the cross-platform cluster bonus. Reddit-domain
  // handle sources (corpus mentions, disclosure findings) attach to clusters
  // directly below and are deliberately excluded here so platform diversity
  // never sees them.
  const handleGroups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (c.signalType !== "handle") continue;
    const key = c.person?.id ?? "";
    const group = handleGroups.get(key) ?? [];
    group.push(c);
    handleGroups.set(key, group);
  }

  for (const group of handleGroups.values()) {
    const person = group[0].person;
    const ranked = rankHandles(
      group
        .filter((c) => c.domain !== "reddit")
        .map((c) => ({ platform: c.platform ?? c.domain, handle: c.display, url: c.evidence || "" })),
      username,
      webSweep?.bridgeEvidence,
    );
    for (const r of ranked) {
      const norm = normalizeHandleKey(r.handle);
      if (!norm || norm === normalizeHandleKey(username)) continue; // drop audited handle
      const acc = findOrCreate("handle", norm, r.handle, "web", person);
      acc.rawValues = new Set([...acc.rawValues, ...r.variants]);
      const variants = new Set(graph ? r.variants.map(normalizeHandleKey) : [norm]);
      for (const s of group.filter((c) => variants.has(c.norm))) {
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
  }

  /* ── Reddit-side handle disclosures join the identity graph ── */
  // The corpus URL-extractor only matches full profile URLs, so a VERBAL
  // disclosure ("my discord is xyz42", no URL) never becomes an observation
  // and the handle registers as web-only / single-domain. Scan the raw corpus
  // texts for word-boundary mentions of each clustered handle; each mentioning
  // text is one reddit-domain source. The audited username never counts (its
  // cluster is already dropped above), and short norms (< 4 chars) are skipped
  // so ambient text doesn't fabricate sources.
  const handleClusterNorms = (): Array<{ acc: ClusterAccumulator; norm: string }> => {
    const out: Array<{ acc: ClusterAccumulator; norm: string }> = [];
    for (const acc of clusters.values()) {
      if (acc.signalType !== "handle") continue;
      if (acc.person && !acc.person.isSubject) continue;
      const norm = normalizeHandleKey(acc.value);
      if (norm.length >= 4) out.push({ acc, norm });
    }
    return out;
  };

  const corpusTexts = input.corpusTexts ?? [];
  if (corpusTexts.length > 0) {
    for (const { acc, norm } of handleClusterNorms()) {
      // Raw spelling variants first (separator drift), then the norm — a
      // corpus saying "john.doe" must match the johndoe cluster via its raw
      // variant even though the norm never appears verbatim.
      const spellings = [...acc.rawValues, norm].filter(Boolean);
      for (let i = 0; i < corpusTexts.length; i++) {
        const ct = corpusTexts[i];
        const text = String(ct?.text ?? "");
        if (!text) continue;
        const hit = spellings.find((s) => mentionsHandleToken(text, s));
        if (!hit) continue;
        const permalink = normPermalink(String(ct?.permalink ?? ""));
        addToCluster(
          acc,
          "reddit",
          `corpus:${permalink || i}`,
          permalink || mentionSnippet(text, hit),
        );
      }
    }
  }

  // cross_platform_handle / external_link findings: the claim text itself
  // often names a handle the URL-extractor missed. Their evidence permalinks
  // are corpus-validated upstream (validateStructuredFindings), so each
  // distinct permalink is one independent reddit-domain source for every
  // handle cluster the claim mentions.
  for (const f of findings) {
    const cat = f?.category;
    if (cat !== "cross_platform_handle" && cat !== "external_link") continue;
    const claim = String(f?.claim ?? "");
    if (!claim) continue;
    const permalinks = [...new Set(
      (f?.evidence ?? [])
        .map((e) => normPermalink(String(e?.permalink ?? "")))
        .filter(Boolean),
    )];
    if (permalinks.length === 0) continue;
    for (const { acc, norm } of handleClusterNorms()) {
      const spellings = [...acc.rawValues, norm].filter(Boolean);
      if (!spellings.some((s) => mentionsHandleToken(claim, s))) continue;
      for (const p of permalinks) {
        addToCluster(acc, "reddit", `permalink:${p}`, p);
      }
    }
  }

  // Emails: exact-keyed clusters.
  for (const c of candidates) {
    if (c.signalType !== "email") continue;
    const acc = findOrCreate("email", c.norm, c.display, c.domain, c.person);
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
      if (existing.person?.id !== c.person?.id) continue;
      if (signalValuesOverlap(c.signalType, existing.value, c.display)) {
        matched = existing;
        break;
      }
    }
    if (!matched) {
      // Only open a new cluster if the norm is meaningful.
      if (!c.norm) continue;
      matched = findOrCreate(c.signalType, c.norm, c.display, c.domain, c.person);
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
      if (graph && acc.person?.id !== personForHandle(login)?.id) continue;
      if (acc.signalType === "age" && login) {
        acc.accountCreated ??= id.accountCreated;
      }
    }
  }

  /* ── Finalize + calibrate clusters ── */
  const localPartEmails = new Set<string>();
  for (const edge of graph?.edges ?? []) {
    if (edge.kind !== "email-of" || edge.strength < 0.6 || !edge.from.startsWith("handle:") || !edge.to.startsWith("email:")) continue;
    const email = edge.to.slice("email:".length);
    if (edge.from !== `handle:${normalizeHandleKey(email.split("@")[0])}`) continue;
    const owner = personByNode.get(edge.from);
    if (owner?.isSubject && personByNode.get(edge.to)?.id === owner.id) localPartEmails.add(email);
  }
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
      if (fc.isSubject === true && localPartEmails.has(email.toLowerCase().trim())) {
        extra += 1;
        fc.emailLocalPartMatch = true;
      }
    }
    if (fc.signalType === "handle") {
      const tier = acc.tier;
      if (fc.independentSources > 0 && (tier === "bridge" || tier === "cross-platform cluster")) extra += 1;
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
    // Labels only ever constrain: POSSIBLE/LIKELY cap confidence; a REJECTED
    // label that survived the candidate filter is subject-owned.
    const status = fc.signalType === "handle" ? statusOf(fc.value) : undefined;
    if (status === "REJECTED") {
      fc.warnings = ["REJECTED label conflicts with deterministic subject ownership; graph evidence retained"];
    } else if (status) {
      fc.accountStatus = status;
      if (status === "POSSIBLE") fc.confidence = "low";
      if (status === "LIKELY" && fc.confidence === "high") fc.confidence = "medium";
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
    if (c.signalType !== "handle" || c.isSubject === false) continue;
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
        if (a.personId !== b.personId) continue;
        if (a.independentSources >= 1 && b.independentSources >= 1) {
          if (a.isSubject !== false) pairs.push(`${a.value} vs ${b.value}`);
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
        if (a.personId !== b.personId) continue;
        if (a.independentSources >= 2 && b.independentSources >= 2) {
          if (a.isSubject !== false) pairs.push(`${a.value} vs ${b.value}`);
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
        if (a.personId !== b.personId) continue;
        const aTok = nameTokens(a.value);
        const bTok = nameTokens(b.value);
        const shared = aTok.some((t) => bTok.includes(t));
        if (!shared && a.independentSources >= 1 && b.independentSources >= 1) {
          if (a.isSubject !== false) pairs.push(`${a.value} vs ${b.value}`);
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
      if (graph && ageCl.personId !== personForHandle(id.login)?.id) continue;
      const created = String(id?.accountCreated ?? "");
      const yearMatch = created.match(/^(\d{4})/);
      if (!yearMatch) continue;
      const createdYear = parseInt(yearMatch[1], 10);
      if (createdYear <= 0) continue;
      const openAge = age - (currentYear - createdYear);
      if (openAge < 8 || age < 10 || age > 100) {
        if (ageCl.isSubject !== false) contradictions.push(
          `Age estimate (${age}) inconsistent with GitHub account created ${createdYear}`,
        );
        ageCl.contradictions = [...(ageCl.contradictions ?? []), `GitHub account created ${createdYear}`];
      }
    }
  }

  // Dedupe contradictions (stable).
  const uniqueContradictions = [...new Set(contradictions)].sort();

  /* ── Score (0–100 advisory exposure gauge) ── */
  const subjectClusters = finalClusters.filter((c) => c.isSubject !== false && c.independentSources > 0);
  let score = 0;
  for (const c of subjectClusters) {
    const baseWeight =
      c.confidence === "high" ? 22 : c.confidence === "medium" ? 12 : 4;
    const identityMult = strongIdentityType(c.signalType) ? 1.3 : 1.0;
    const contradPenalty = (c.contradictions?.length ?? 0) > 0 ? 4 : 0;
    score += baseWeight * identityMult - contradPenalty;
  }
  score = clamp(Math.round(score), 0, 100);

  // Exposure floor: a rename / anchor-rename / disclosure edge (strength >= 0.7)
  // joining the audited handle to another subject handle proves the subject's
  // clusters are the subject's, even when one profile supplied them all (each
  // single-source, so low confidence). It floors exposure, never adds sources:
  // any subject strong-identity cluster → "medium"; a real name AND an email →
  // "high". Applied before the contradiction downgrade, which still costs a step.
  const auditedNode = `handle:${normalizeHandleKey(username)}`;
  const linked = !!subject && (graph?.edges ?? []).some((e) =>
    (e.kind === "rename" || e.kind === "anchor-rename" || e.kind === "disclosure") && e.strength >= 0.7 &&
    (e.from === auditedNode || e.to === auditedNode) && e.from !== e.to &&
    subject.handleNodes.includes(e.from) && subject.handleNodes.includes(e.to));
  const exposed = linked ? subjectClusters.filter((c) =>
    c.isSubject === true && strongIdentityType(c.signalType) && c.accountStatus !== "POSSIBLE") : [];
  const floor: Confidence = exposed.some((c) => c.signalType === "real_name") && exposed.some((c) => c.signalType === "email") ? "high" :
    exposed.length > 0 ? "medium" : "low";
  const overallRisk = mapOverallRisk(finalClusters, uniqueContradictions, floor);

  const verdict = buildVerdict({
    overallRisk,
    clusters: subjectClusters,
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
    rejectedAccounts,
  };
}

/** Containment / token-overlap predicate for fuzzy cluster merging. */

/**
 * All comma-split location segments, lowercased/trimmed, parentheticals
 * stripped: "Uppal, Hyderabad, India" → ["uppal", "hyderabad", "india"].
 * Feeds the nested-location containment merge — a neighborhood/city/state
 * chain and a bare city inside it are ONE place at different granularity,
 * not two conflicting locations.
 */
function locationSegments(raw: string): string[] {
  return clean(raw)
    .replace(/\([^)]*\)/g, " ")
    .split(",")
    .map((s) => s.replace(/^the\s+/, "").trim())
    .filter(Boolean);
}

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
      if (a === b || a.includes(b) || b.includes(a)) return true;
      // Nested containment: one side's HEAD (most-specific) segment appearing
      // anywhere in the other side's FULL segment set means the two describe
      // the same place at different granularity ("Uppal, Hyderabad, India" vs
      // "Hyderabad" → merge). Head-to-full only, in either direction — naive
      // segment intersection would collapse any two cities sharing a country
      // ("Chennai, India" vs "Hyderabad, India" must stay separate).
      const segA = locationSegments(existingValue);
      const segB = locationSegments(newValue);
      const headA = segA[0] ?? "";
      const headB = segB[0] ?? "";
      if (!headA || !headB) return false;
      return segB.includes(headA) || segA.includes(headB);
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
  return { clusters: [], score: 0, overallRisk: "low", contradictions: [], warnings: [], verdict: emptyVerdict(), rejectedAccounts: [] };
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
  if (result.clusters.length === 0 && result.warnings.length === 0 && result.rejectedAccounts.length === 0) return "";
  const lines: string[] = [];
  lines.push(`## Cross-Signal Corroboration`);
  lines.push("");
  lines.push(
    `*Deterministic fusion pass (no LLM) — clusters independent signals that assert the same entity and counts each originating document once, even when several collectors read it. Account verification labels can only lower confidence. ${result.clusters.length} cluster(s), ${result.contradictions.length} contradiction(s). Overall corroborated risk: ${RISK_BADGE[result.overallRisk]}. Exposure score: ${result.score}/100.*`,
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
    if (result.clusters.some((c) => c.personId)) {
      lines.push(`*Separate persons are excluded from the subject's score/verdict. A local-part match adds +1 confidence, not another source.*`);
      lines.push("");
    }
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
      if (c.isSubject === false) flags.push("separate person — excluded");
      if ((c.contradictions?.length ?? 0) > 0) {
        flags.push(`⚠️ conflict: ${c.contradictions![0]}`);
      }
      if ((c.warnings?.length ?? 0) > 0) {
        flags.push(`⚠️ ${c.warnings![0]}`);
      }
      if (c.signalType === "handle") {
        if (c.accountStatus) flags.push(c.accountStatus);
        if (c.tier === "bridge") flags.push("🌉 bridge");
        else if (c.tier === "cross-platform cluster") flags.push("🔗 cluster");
      }
      if (c.signalType === "email" && !isEmptyBreakdown(c.sourceBreakdown)) {
        if (c.freemail === false) flags.push("🌐 custom domain");
        if (c.emailLocalPartMatch) flags.push("local-part match (+1)");
      }
      if (!c.independentSources) flags.push("unverified — zero weight");
      else if (!c.corroborating) flags.push("single-source");

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

  if (result.rejectedAccounts.length > 0) {
    lines.push("");
    lines.push(`**Removed by REJECTED labels** (with every observation read off them): ${result.rejectedAccounts.join(", ")}`);
  }

  return lines.join("\n");
}
