/**
 * Evidence provenance model — the "research contract" types (Phase 0).
 *
 * Historically this codebase carried ONE overloaded concept — "risk" — that
 * conflated three distinct questions:
 *
 *   1. Observation        — what a source literally contains.
 *   2. Candidate linkage  — why that source *might* belong to the Reddit subject.
 *   3. Corroborated attribution — independently supported same-person linkage.
 *
 * Conflating them is what let a single GitHub observation be counted as two
 * independent domains (the corroboration double-count), let a hallucinated
 * model email become a "deterministic direct identifier", and let schema-valid
 * evidence pass as real evidence. This module re-establishes the contract.
 *
 * It holds:
 *   - `EvidenceObservation`     — the immutable provenance unit (lineage IDs).
 *   - `IdentifierCollections`   — identifiers kept strictly separated by the
 *                                 source domain that produced them, so no one
 *                                 observation is ever counted under two
 *                                 corroboration domains. Merging for DISPLAY
 *                                 happens only at render time.
 *   - `AuditVerdict`            — the de-overloaded verdict: three orthogonal
 *                                 axes (exposure severity, attribution
 *                                 confidence, evidence quality) + a typed
 *                                 contradiction list. The legacy `overallRisk`
 *                                 enum is retained as a compatibility
 *                                 projection of `exposureSeverity`.
 *
 * Milestone 1 introduces these types and the lineage discipline that kills the
 * double-count / model-contamination / unvalidated-evidence failure modes.
 * Milestone 2 will attach full content hashes + run manifests for replayable
 * artifacts on top of the same shapes.
 */

import type { DirectIdentifiers } from "./extract.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Observation provenance
 * ──────────────────────────────────────────────────────────────────────── */

/** The kind of source an observation was read from. */
export type EvidenceSourceType =
	| "reddit"
	| "web-page"
	| "search-snippet"
	| "github-profile"
	| "github-commit";

/** How an identifier or signal was pulled out of its source. */
export type ExtractionMethod = "regex" | "api-field" | "model";

/** Lifecycle state of an observation as it moves toward attribution. */
export type EvidenceStatus = "observed" | "candidate" | "corroborated" | "rejected";

/** Which pipeline stage produced an observation. Maps 1:1 to the identifier
 *  collection it belongs in — the separation that prevents double-counting. */
export type EvidenceStage = "corpus" | "web-sweep" | "github-pass" | "model-report";

/**
 * One immutable observation backing an identifier or signal. The lineage unit.
 * Two identifiers that trace back to the same `id` are ONE observation, no
 * matter how many report containers repeat the value.
 *
 * (Milestone 1 carries the shape + stage tag; Milestone 2 fills `contentHash`
 *  and `retrievedAt` from real fetches for offline replay.)
 */
export interface EvidenceObservation {
	id: string;
	sourceType: EvidenceSourceType;
	sourceUrl?: string;
	retrievedAt: string;
	contentHash: string;
	excerpt: string;
	extractionMethod: ExtractionMethod;
	stage: EvidenceStage;
	status: EvidenceStatus;
	parentEvidenceIds: string[];
}

/* ────────────────────────────────────────────────────────────────────────
 * Separated identifier collections
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Identifier observations, kept strictly separated by the source domain that
 * produced them. The load-bearing rule:
 *
 *     corroboration counts ONE observation exactly ONCE — under the single
 *     domain that actually produced it. Never merge these before corroboration.
 *
 * `corpus`     — regex over the RAW Reddit history (pre-filter, so identifiers
 *                in items the heuristic filter dropped are still found).
 *                Deterministic.
 * `web`        — regex over the deterministic web sweep's SCRAPED pages only
 *                (never search snippets). Deterministic.
 * `github`     — GitHub REST API profile fields + author-verified commit
 *                identities. Deterministic.
 * `twitter`    — twitter-cli profile reads + follow-graph alt-account
 *                candidates + website/bio/tweet identifiers. Deterministic.
 * `modelMentioned` — regex over the LLM report text. NOT deterministic: the
 *                model may paraphrase, repeat, or hallucinate. It is NEVER
 *                counted as an independent corroboration domain — it is surfaced
 *                separately so an invented email can never masquerade as a
 *                verified leak.
 */
export interface IdentifierCollections {
	corpus: DirectIdentifiers;
	web: DirectIdentifiers;
	github: DirectIdentifiers;
	twitter: DirectIdentifiers;
	modelMentioned: DirectIdentifiers;
}

/** Build an empty collection bag (useful for the no-corpus standard path). */
export function emptyIdentifierCollections(): IdentifierCollections {
	return {
		corpus: { emails: [], socialHandles: [] },
		web: { emails: [], socialHandles: [] },
		github: { emails: [], socialHandles: [] },
		twitter: { emails: [], socialHandles: [] },
		modelMentioned: { emails: [], socialHandles: [] },
	};
}

/**
 * Merge the four collections into a single deduped display set. Used ONLY for
 * report rendering / display projections — never as an input to corroboration.
 * `modelMentioned` is excluded by default so displayed "direct identifiers"
 * stay deterministic; pass `includeModel: true` to fold it in (clearly labeled
 * at the call site).
 */
export function mergeIdentifiersForDisplay(
	collections: IdentifierCollections,
	includeModel = false,
): DirectIdentifiers {
	const emails = new Set<string>();
	const handleKeys = new Set<string>();
	const handles: DirectIdentifiers["socialHandles"] = [];
	const addDi = (di: DirectIdentifiers) => {
		for (const e of di.emails) emails.add(e);
		for (const h of di.socialHandles) {
			const k = `${h.platform}:${h.handle.toLowerCase()}`;
			if (handleKeys.has(k)) continue;
			handleKeys.add(k);
			handles.push(h);
		}
	};
	addDi(collections.corpus);
	addDi(collections.web);
	addDi(collections.github);
	addDi(collections.twitter);
	if (includeModel) addDi(collections.modelMentioned);
	return { emails: [...emails], socialHandles: handles };
}

/* ────────────────────────────────────────────────────────────────────────
 * The de-overloaded verdict
 * ──────────────────────────────────────────────────────────────────────── */

/** Verdict axis level (lowercase, matching the corroboration layer's vocab). */
export type VerdictLevel = "low" | "medium" | "high";

/** A single contradiction between independently-sourced signals. */
export interface Contradiction {
	/** the signal dimension that conflicts (location / employer / real_name / …) */
	signalType: string;
	/** human-readable description */
	description: string;
	/** the disagreeing values */
	values: string[];
}

/**
 * The de-overloaded audit verdict. Three orthogonal axes + contradictions.
 *
 *   exposureSeverity      — how much the pseudonymous footprint leaks (the
 *                           legacy "overallRisk" ladder, retained as a
 *                           compatibility projection of this field).
 *   attributionConfidence — how strongly the evidence resolves to ONE real
 *                           person (independent multi-domain identity anchors,
 *                           penalized by identity contradictions).
 *   evidenceQuality       — how well-supported the evidence base is overall
 *                           (validated, multi-domain, corroborated signals vs.
 *                           single-source / unvalidated / model-only).
 *
 * Replaces the overloaded single "risk" concept. `overallRisk` on
 * StructuredFindings / CorroborationResult is kept only as a backwards-
 * compatible projection of `exposureSeverity`.
 */
export interface AuditVerdict {
	exposureSeverity: VerdictLevel;
	attributionConfidence: VerdictLevel;
	evidenceQuality: VerdictLevel;
	contradictions: Contradiction[];
}

/** An all-low verdict with no contradictions (the safe default / empty state). */
export function emptyVerdict(): AuditVerdict {
	return {
		exposureSeverity: "low",
		attributionConfidence: "low",
		evidenceQuality: "low",
		contradictions: [],
	};
}

/* ────────────────────────────────────────────────────────────────────────
 * Verdict derivation (pure; called by the corroboration layer)
 * ──────────────────────────────────────────────────────────────────────── */

/** Minimal structural view of a corroboration cluster + validation stats —
 *  enough to derive the verdict without importing the full CorroborationResult
 *  type (keeps this module a leaf with no import cycle). */
export interface VerdictInput {
	/** the calibrated risk ladder (becomes exposureSeverity). */
	overallRisk: VerdictLevel;
	clusters: Array<{
		signalType: string;
		independentSources: number;
		domainCount: number;
		corroborating: boolean;
		contradictions?: string[];
	}>;
	contradictionStrings: string[];
	/** optional structured-evidence validation stats. */
	evidenceValidation?: { checked: number; supported: number; unsupported: number };
}

/** Signal types that directly attribute a real person (drive attribution). */
function isStrongIdentity(signalType: string): boolean {
	return signalType === "real_name" || signalType === "email" || signalType === "handle";
}

/** Infer a signal-type tag from a free-form contradiction string. */
function contradictionSignalType(desc: string): string {
	const d = desc.toLowerCase();
	if (d.includes("location") || d.includes("cit") || d.includes("geograph")) return "location";
	if (d.includes("employer") || d.includes("compan") || d.includes("school")) return "employer";
	if (d.includes("name")) return "real_name";
	if (d.includes("age")) return "age";
	return "general";
}

/**
 * Derive the de-overloaded AuditVerdict from a corroboration result (+ optional
 * evidence-validation stats). Pure function of its inputs.
 *
 *   exposureSeverity      ← the calibrated risk ladder (overallRisk).
 *   attributionConfidence ← presence of corroborated, cross-domain STRONG
 *                           identity anchors (name/email/handle), capped by
 *                           identity contradictions.
 *   evidenceQuality       ← breadth of multi-domain corroboration and the
 *                           fraction of validated (corpus-supported) evidence.
 */
export function buildVerdict(input: VerdictInput): AuditVerdict {
	const clusters = input.clusters ?? [];
	const strongCorroborated = clusters.filter(
		(c) => isStrongIdentity(c.signalType) && c.corroborating && c.independentSources >= 2,
	);
	const strongAny = clusters.filter(
		(c) => isStrongIdentity(c.signalType) && c.independentSources >= 1,
	);
	const multiDomain = clusters.filter((c) => c.domainCount >= 2);
	const corroborated = clusters.filter((c) => c.corroborating);

	// Identity contradictions cap attribution confidence.
	const identityContradictions = input.contradictionStrings.filter((d) => {
		const t = contradictionSignalType(d);
		return t === "real_name" || t === "location" || t === "general";
	});

	let attribution: VerdictLevel;
	if (strongCorroborated.length >= 1 && identityContradictions.length === 0) {
		attribution = "high";
	} else if (strongAny.length >= 1 || (corroborated.length >= 2 && identityContradictions.length === 0)) {
		attribution = "medium";
	} else {
		attribution = "low";
	}
	if (identityContradictions.length > 0 && attribution === "high") attribution = "medium";

	// Evidence quality: breadth of multi-domain corroboration, penalized by the
	// unsupported-evidence ratio from findings validation.
	const v = input.evidenceValidation;
	const unsupportedRatio = v && v.checked > 0 ? v.unsupported / v.checked : 0;
	let quality: VerdictLevel;
	if (multiDomain.length >= 3 && unsupportedRatio <= 0.1) quality = "high";
	else if (corroborated.length >= 2 && unsupportedRatio <= 0.3) quality = "medium";
	else quality = "low";

	const contradictions: Contradiction[] = input.contradictionStrings.map((desc) => ({
		signalType: contradictionSignalType(desc),
		description: desc,
		values: [],
	}));

	return {
		exposureSeverity: input.overallRisk,
		attributionConfidence: attribution,
		evidenceQuality: quality,
		contradictions,
	};
}
