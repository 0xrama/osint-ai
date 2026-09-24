/**
 * Evaluation harness schema — types for golden fixtures, metrics, and scoring.
 *
 * The eval harness measures how well the deterministic attribution layers
 * (web-sweep, github-pass, corroboration, extract, findings-validation)
 * perform against known ground truth. LLM-layer evaluation waits on the
 * offline-replay infrastructure from Milestone 2.
 *
 * Each fixture supplies raw inputs (search results, scraped pages, GitHub API
 * responses, Reddit history) plus ground-truth answers, and the runner compares
 * the attribution layers' output against that ground truth.
 *
 * Fixtures are versioned so scoring logic can evolve without breaking old data.
 */

import type { FirecrawlSearchResult, ScrapeResult } from "../runtime/firecrawl.ts";
import type { WebSweepDeps } from "../analysis/web-sweep.ts";
import type { GitHubIdentity } from "../analysis/github-pass.ts";
import type { DirectIdentifiers } from "../analysis/extract.ts";
import type { CorroborationResult } from "../analysis/corroboration.ts";
import type { VerdictLevel } from "../analysis/evidence.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Fixture categories (the 11 edge-case buckets from the assessment)
 * ──────────────────────────────────────────────────────────────────────── */

export type FixtureCategory =
  | "bridge"
  | "unrelated-handle"
  | "common-username"
  | "collaborator-commit"
  | "vendor-email"
  | "distractor"
  | "renamed-handle"
  | "conflicting-signal"
  | "no-identity"
  | "partial-archive"
  | "deleted-content";

export const ALL_CATEGORIES: FixtureCategory[] = [
  "bridge",
  "unrelated-handle",
  "common-username",
  "collaborator-commit",
  "vendor-email",
  "distractor",
  "renamed-handle",
  "conflicting-signal",
  "no-identity",
  "partial-archive",
  "deleted-content",
];

/* ────────────────────────────────────────────────────────────────────────
 * Fixture input shape
 * ──────────────────────────────────────────────────────────────────────── */

/** Raw Reddit history item (mirrors the fields the pipeline reads). */
export interface FixtureRedditItem {
  id?: string;
  body: string;
  title?: string;
  permalink: string;
  subreddit: string;
  author?: string;
  created_utc: number;
  score?: number;
  is_deleted?: boolean;
  is_removed?: boolean;
}

/** Raw inputs the deterministic attribution layers consume. */
export interface FixtureInputs {
  /** The audited Reddit username. */
  username: string;
  /** Raw Reddit history (pre-filter). */
  redditHistory?: FixtureRedditItem[];
  /** Search results, keyed by query string. */
  searchResults: Record<string, FirecrawlSearchResult[]>;
  /** Scraped pages, keyed by URL. */
  scrapedPages: Record<string, ScrapeResult>;
  /** GitHub REST API /users/<login> responses, keyed by login. */
  githubProfiles: Record<string, Partial<GitHubIdentity> & { login: string }>;
  /** GitHub commit responses, keyed by `owner/repo`. */
  githubCommits: Record<string, Array<{ commit: { author: { name: string; email: string; date?: string } }; author: { login: string } | null }>>;
  /** Pre-built structured findings (LLM layer mock). When present, the runner
   *  injects these directly into corroboration so the LLM-free eval path still
   *  exercises contradiction detection and evidence validation. */
  findings?: Array<{ category: string; claim: string; confidence?: "low" | "medium" | "high"; evidence?: Array<{ quote: string; permalink: string }> }>;
}

/* ────────────────────────────────────────────────────────────────────────
 * Ground truth
 * ──────────────────────────────────────────────────────────────────────── */

export interface FixtureGroundTruth {
  /** Identifiers that genuinely belong to the subject. */
  identifiers: {
    /** Emails verified to belong to the subject. */
    emails: string[];
    /** Handles verified to belong to the subject. */
    handles: Array<{ platform: string; handle: string }>;
  };
  /** Known bridge edges: page owned by `owner` that mentions `mentions`. */
  bridgeEdges: Array<{ owner: string; mentions: string; url: string }>;
  /** Identifiers that are explicitly NOT the subject's. */
  nonIdentifiers: {
    emails: string[];
    handles: Array<{ platform: string; handle: string }>;
  };
  /** Known real name, for top-1 attribution scoring. */
  subjectName?: string;
  /** Known location, for location-accuracy scoring. */
  subjectLocation?: string;
  /** Known employer, for employer-accuracy scoring. */
  subjectEmployer?: string;
  /** Expected corroboration risk level. */
  expectedRisk?: VerdictLevel;
  /** True when the subject has no resolvable real identity. */
  noResolvableIdentity?: boolean;
  /** True when the fixture should trigger a contradiction. */
  expectContradiction?: boolean;
  /** Known GitHub logins that belong to the subject. */
  subjectGitHubLogins?: string[];
}

/* ────────────────────────────────────────────────────────────────────────
 * Full fixture
 * ──────────────────────────────────────────────────────────────────────── */

export interface EvalFixture {
  /** Stable fixture id (e.g. "bridge-1"). */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Schema version (bump when the fixture shape changes). */
  version: number;
  /** Which edge-case categories this fixture covers. */
  categories: FixtureCategory[];
  inputs: FixtureInputs;
  groundTruth: FixtureGroundTruth;
}

/* ────────────────────────────────────────────────────────────────────────
 * DEPs: build injectable mocks from the fixture
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Build a WebSweepDeps from fixture inputs, so the sweep can be run
 * deterministically against known search results and scraped pages without
 * a network. The search seam queries the fixture by query string; the scrape
 * seam queries by URL; redditAbout returns null (not relevant for eval).
 */
export function buildSweepDeps(inputs: FixtureInputs): WebSweepDeps {
  // Collect all search results from the fixture, indexed by the seed/target
  // they relate to (not by exact query string — the sweep internally generates
  // precise query strings like site:github.com "handle" and we can't know them
  // all at fixture-authoring time). Also build a URL→scraped page map.
  let allSearchResults: FirecrawlSearchResult[] = [];
  for (const results of Object.values(inputs.searchResults)) {
    allSearchResults = allSearchResults.concat(results);
  }
  const scrapedByUrl = new Map<string, ScrapeResult>();
  for (const [url, page] of Object.entries(inputs.scrapedPages)) {
    scrapedByUrl.set(url.replace(/\/$/, "").toLowerCase(), page);
  }

  return {
    search: async (query) => {
      // The sweep fires queries like site:github.com "username",
      // "handle" portfolio OR..., handle github OR... Extract the
      // quoted bare token and return fixture results that mention it.
      const bareMatch = query.match(/"([^"]+)"/);
      const bare: string | null = bareMatch ? bareMatch[1].toLowerCase().trim() : null;
      // Also extract any unquoted seed token (e.g. "fixtureveil github" → fixtureveil).
      const wordMatch = query.match(/^([a-zA-Z0-9_-]+)\s/);
      const word: string | null = wordMatch ? wordMatch[1].toLowerCase().trim() : null;

      const candidates = allSearchResults.filter((r) => {
        const t = `${r.title} ${r.description}`.toLowerCase();
        if (bare && (t.includes(bare) || r.url.toLowerCase().includes(bare))) return true;
        if (word && (t.includes(word) || r.url.toLowerCase().includes(word))) return true;
        return false;
      });
      return candidates;
    },
    scrape: async (url, _opts) => {
      const key = url.replace(/\/$/, "").toLowerCase();
      const exact = scrapedByUrl.get(key);
      if (exact) return exact;
      // Try with/without www. prefix.
      for (const [k, v] of scrapedByUrl) {
        const a = key.replace(/^https?:\/\/(www\.)?/, "");
        const b = k.replace(/^https?:\/\/(www\.)?/, "");
        if (a === b) return v;
      }
      return { url, title: url, description: "", markdown: "", links: [] };
    },
    followSite: async (url) => {
      const key = url.replace(/\/$/, "").toLowerCase();
      const exact = scrapedByUrl.get(key);
      if (exact) {
        const links = exact.links?.length ? `\n\nLinks found on page:\n${exact.links.join("\n")}` : "";
        return { url, text: `${exact.title}\n${exact.markdown}${links}` };
      }
      return null;
    },
    redditAbout: async () => null,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Metrics for a single fixture run
 * ──────────────────────────────────────────────────────────────────────── */

export interface EvalMetrics {
  fixtureId: string;

  /** Identifier precision/recall/F1 (emails + handles pooled). */
  identifierPrecision: number;
  identifierRecall: number;
  identifierF1: number;

  /** Citation validity rate (supported / total evidence entries). */
  citationValidityRate: number;

  /** Bridge detection quality. */
  bridgePrecision: number;
  bridgeRecall: number;
  bridgeFalsePositiveRate: number;

  /** Handle-link precision: of all handles we attributed to the subject,
   *  what fraction are actually theirs? */
  candidateLinkPrecision: number;

  /** Top-1 attribution accuracy (is the top-ranked name/identity correct?). */
  attributionTop1Correct: boolean;
  attributionTopKCorrect: boolean;

  /** Contradiction detection accuracy. */
  contradictionCorrect: boolean;

  /** Detailed lists for inspection. */
  truePositives: string[];
  falsePositives: string[];
  falseNegatives: string[];
}

/** Aggregated metrics across all fixtures. */
export interface AggregateMetrics {
  fixtureCount: number;
  categoryCoverage: Partial<Record<FixtureCategory, number>>;

  meanIdentifierF1: number;
  meanCitationValidity: number;
  meanBridgeF1: number;
  meanCandidateLinkPrecision: number;
  attributionTop1Rate: number;
  contradictionAccuracy: number;

  perFixture: EvalMetrics[];
  failures: Array<{ fixtureId: string; error: string }>;
}

/* ────────────────────────────────────────────────────────────────────────
 * Scoring helpers (pure)
 * ──────────────────────────────────────────────────────────────────────── */

/** Compute precision/recall/F1 from true/false positive/negative sets. */
export function computePRF1(
  tp: string[],
  fp: string[],
  fn: string[],
): { precision: number; recall: number; f1: number } {
  const tpCount = tp.length;
  const fpCount = fp.length;
  const fnCount = fn.length;
  const precision = tpCount + fpCount > 0 ? tpCount / (tpCount + fpCount) : 0;
  const recall = tpCount + fnCount > 0 ? tpCount / (tpCount + fnCount) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

/** Pool emails + handles into deduped normalized key sets for comparison. */
export function identifierKeys(di: DirectIdentifiers): Set<string> {
  const s = new Set<string>();
  for (const e of di.emails) s.add(`email:${e.toLowerCase()}`);
  for (const h of di.socialHandles) s.add(`${h.platform}:${h.handle.toLowerCase()}`);
  return s;
}

/**
 * Compare extracted identifiers against ground truth. Returns TP/FP/FN lists.
 * Ground-truth non-identifiers appearing in the extracted set count as FP.
 */
export function scoreIdentifiers(
  extracted: DirectIdentifiers,
  groundTruth: FixtureGroundTruth,
): { tp: string[]; fp: string[]; fn: string[] } {
  const extractedSet = identifierKeys(extracted);
  const gtSet = new Set<string>();
  for (const e of groundTruth.identifiers.emails) gtSet.add(`email:${e.toLowerCase()}`);
  for (const h of groundTruth.identifiers.handles) gtSet.add(`${h.platform}:${h.handle.toLowerCase()}`);
  const nonSet = new Set<string>();
  for (const e of groundTruth.nonIdentifiers.emails) nonSet.add(`email:${e.toLowerCase()}`);
  for (const h of groundTruth.nonIdentifiers.handles) nonSet.add(`${h.platform}:${h.handle.toLowerCase()}`);

  const tp: string[] = [];
  const fp: string[] = [];
  const fn: string[] = [];

  for (const k of extractedSet) {
    if (gtSet.has(k)) tp.push(k);
    else if (nonSet.has(k)) fp.push(k);
    // Extracted items in neither set are ignored (not scored as FP —
    // the fixture may not enumerate every unrelated hit).
  }
  for (const k of gtSet) {
    if (!extractedSet.has(k)) fn.push(k);
  }
  return { tp, fp, fn };
}

/**
 * Score bridge detection — compare extracted bridge edges against ground truth.
 */
export function scoreBridges(
  bridgeOwnerHandles: string[] | undefined,
  groundTruth: FixtureGroundTruth,
): { tp: string[]; fp: string[]; fn: string[] } {
  const extracted = new Set(bridgeOwnerHandles?.map((h) => h.toLowerCase()) ?? []);
  const gtOwners = new Set(groundTruth.bridgeEdges.map((e) => e.owner.toLowerCase()));

  const tp: string[] = [];
  const fp: string[] = [];
  const fn: string[] = [];

  for (const owner of extracted) {
    if (gtOwners.has(owner)) tp.push(owner);
    else fp.push(owner);
  }
  for (const owner of gtOwners) {
    if (!extracted.has(owner)) fn.push(owner);
  }
  return { tp, fp, fn };
}

/**
 * Score how many attributed handles (web + github) are actually the subject's
 * vs. random lookalikes.
 */
export function scoreHandleAttribution(
  attributed: DirectIdentifiers,
  groundTruth: FixtureGroundTruth,
): { tp: string[]; fp: string[] } {
  const gtSet = new Set<string>();
  for (const h of groundTruth.identifiers.handles) gtSet.add(`${h.platform}:${h.handle.toLowerCase()}`);
  const nonSet = new Set<string>();
  for (const h of groundTruth.nonIdentifiers.handles) nonSet.add(`${h.platform}:${h.handle.toLowerCase()}`);

  const tp: string[] = [];
  const fp: string[] = [];
  for (const h of attributed.socialHandles) {
    const k = `${h.platform}:${h.handle.toLowerCase()}`;
    if (gtSet.has(k)) tp.push(k);
    else if (nonSet.has(k)) fp.push(k);
  }
  for (const e of attributed.emails) {
    const gtE = groundTruth.identifiers.emails.map((x) => x.toLowerCase());
    const nonE = groundTruth.nonIdentifiers.emails.map((x) => x.toLowerCase());
    if (gtE.includes(e.toLowerCase())) tp.push(`email:${e.toLowerCase()}`);
    else if (nonE.includes(e.toLowerCase())) fp.push(`email:${e.toLowerCase()}`);
  }
  return { tp, fp };
}

/**
 * True when the top-ranked corroboration cluster matches the known subject
 * identity (name, location, or employer).
 */
export function scoreAttribution(
  corroboration: CorroborationResult | undefined,
  groundTruth: FixtureGroundTruth,
): { top1Correct: boolean; topKCorrect: boolean } {
  // Top-1: does the highest-confidence identity cluster match the known name?
  const identityClusters = (corroboration?.clusters ?? []).filter(
    (c) => c.signalType === "real_name" || c.signalType === "email" || c.signalType === "handle",
  );
  const top1 = identityClusters[0];
  let top1Correct = false;
  let topKCorrect = false;

  if (groundTruth.noResolvableIdentity) {
    // The correct answer is "no identity resolved" → high-confidence identity
    // clusters are false positives.
    top1Correct = !top1 || top1.confidence === "low";
    topKCorrect = identityClusters.filter((c) => c.confidence !== "low").length === 0;
  } else if (groundTruth.subjectName) {
    const nameNorm = groundTruth.subjectName.toLowerCase();
    top1Correct = top1?.signalType === "real_name" && top1.value.toLowerCase().includes(nameNorm);
    topKCorrect = identityClusters.some(
      (c) => c.signalType === "real_name" && c.value.toLowerCase().includes(nameNorm),
    );
  } else if (groundTruth.identifiers.emails.length > 0) {
    const emailNorm = groundTruth.identifiers.emails[0].toLowerCase();
    top1Correct = top1?.signalType === "email" && top1.value.toLowerCase() === emailNorm;
    topKCorrect = identityClusters.some(
      (c) => c.signalType === "email" && c.value.toLowerCase() === emailNorm,
    );
  } else {
    // No strong attribution anchor in the ground truth — skip.
    top1Correct = true;
    topKCorrect = true;
  }
  return { top1Correct, topKCorrect };
}

/**
 * Score contradiction detection: did we flag a contradiction when we should
 * have? Did we falsely flag one when we shouldn't have?
 */
export function scoreContradictions(
  contradictions: string[],
  groundTruth: FixtureGroundTruth,
): { correct: boolean } {
  const hasContradiction = contradictions.length > 0;
  const shouldHave = groundTruth.expectContradiction === true;
  return { correct: hasContradiction === shouldHave };
}

/** Aggregate per-fixture metrics into an AggregateMetrics report. */
export function aggregateMetrics(perFixture: EvalMetrics[]): AggregateMetrics {
  const failures = perFixture.filter((m) => m.identifierF1 < 0);
  const valid = perFixture.filter((m) => m.identifierF1 >= 0);

  return {
    fixtureCount: perFixture.length,
    categoryCoverage: {}, // filled by runner
    meanIdentifierF1: mean(valid.map((m) => m.identifierF1)),
    meanCitationValidity: mean(valid.map((m) => m.citationValidityRate)),
    meanBridgeF1: mean(valid.map((m) => {
      const p = m.bridgePrecision;
      const r = m.bridgeRecall;
      return p + r > 0 ? (2 * p * r) / (p + r) : 0;
    })),
    meanCandidateLinkPrecision: mean(valid.map((m) => m.candidateLinkPrecision)),
    attributionTop1Rate: valid.filter((m) => m.attributionTop1Correct).length / Math.max(1, valid.length),
    contradictionAccuracy: valid.filter((m) => m.contradictionCorrect).length / Math.max(1, valid.length),
    perFixture,
    failures: failures.map((m) => ({ fixtureId: m.fixtureId, error: "computation failed" })),
  };
}

function mean(vals: number[]): number {
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
