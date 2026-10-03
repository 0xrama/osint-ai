/**
 * Unified audit pipeline.
 *
 * One entry point (`runAudit`) drives the whole tool and reports progress via
 * callbacks, so the CLI / dashboard stay thin view layers.
 *
 * There is one analysis path: ensure local JSONL (download if missing) →
 * multi-agent deep-analysis → synthesis report. Only if no data can be
 * downloaded does it fall back to the live tool-driven agent
 * (reddit_search / web tools), which fetches history itself.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadJsonlFiles, downloadUser } from "../reddit/download.ts";
import { runDeepAnalysis, formatDeepAnalysisReport } from "./deep-analysis.ts";
import { runAgentWithTools } from "../runtime/agent.ts";
import { buildRuntimeTools } from "../runtime/tools.ts";
import { mcpWebPreferred, mcpWebNote, webToolsAvailable } from "../runtime/providers/index.ts";
import { ANALYST_SYSTEM_PROMPT, buildUserPrompt } from "../prompts.ts";
import { runDeterministicWebSweep, renderWebSweepBlock, renderWebContextForPrompt, sweepCapable, rankHandles, type WebSweepResult } from "./web-sweep.ts";
import { runGitHubPass, renderGitHubBlock, renderGitHubContextForPrompt, gitHubIdentifiers, type GitHubPassResult } from "./github-pass.ts";
import { runTwitterPass, twitterAvailable, renderTwitterBlock, renderTwitterContextForPrompt, twitterIdentifiers, type TwitterPassResult } from "./twitter-pass.ts";
import { extractDirectIdentifiers, renderDirectIdentifiersBlock, renderModelMentionedBlock } from "./extract.ts";
import { extractStructuredFindings, renderStructuredFindings, validateStructuredFindings, type StructuredFindings } from "./findings.ts";
import { computeCorroboration, renderCorroborationBlock, maxRisk, type CorroborationResult } from "./corroboration.ts";
import { estimateUtcOffset, renderTimezoneBlock, renderTimezoneContextForPrompt, type TimezoneEstimate } from "./timezone.ts";
import { renderSubAgentLeadsDigest } from "./leads-digest.ts";
import { estimateAges, renderAgeBlock, type AgeEstimate } from "./age.ts";
import { runExistenceProbes, renderExistenceProbeBlock, renderExistenceProbeContextForPrompt, type ExistenceProbeResult } from "./existence-probe.ts";
import { runArchivePass, renderArchiveBlock, renderArchiveContextForPrompt, type ArchivePassResult } from "./archive-pass.ts";
import { buildIdentityGraph, renderIdentityGraphBlock, renderIdentityGraphContextForPrompt, type IdentityGraph } from "./identity-graph.ts";
import { mergeIdentifiersForDisplay, type IdentifierCollections, type AuditVerdict } from "./evidence.ts";
import type { DirectIdentifiers } from "./extract.ts";
import type { Candidate } from "../types.ts";

export interface AuditOptions {
	username: string;
	years: number;
	web: boolean;
	/** Opt-in Twitter/X pass via the operator's twitter-cli (--twitter). */
	twitter?: boolean;
	dataDir: string;
	candidate?: Candidate;
}

export interface AuditResult {
	content: string;
	toolCalls: number;
	iterations: number;
	/** Deterministic identifiers (corpus + web + GitHub), merged for display.
	 *  Model-mentioned identifiers are excluded — see `modelMentionedIdentifiers`. */
	directIdentifiers?: DirectIdentifiers;
	/** Identifiers extracted from the LLM report text ONLY — unverified, kept
	 *  separate so they cannot masquerade as deterministic leaks or count as an
	 *  independent corroboration source. */
	modelMentionedIdentifiers?: DirectIdentifiers;
	/** Identifiers strictly separated by source domain (the provenance source
	 *  of truth; corroboration consumes these, never a pre-merged set). */
	identifierCollections?: IdentifierCollections;
	/** Machine-readable projection of the report into a strict schema. */
	structured?: StructuredFindings;
	/** Deterministic cross-signal corroboration verdict (triangulation layer). */
	corroboration?: CorroborationResult;
	/** The de-overloaded verdict (exposure / attribution / evidence quality). */
	verdict?: AuditVerdict;
	/** The narrative "Executive Summary — Person Brief" paragraph, for quick display. */
	brief?: string;
	/** Combined machine-readable shape for --json output. */
	json?: any;
}

/** Strip light markdown (bold/italic/code/links) for clean terminal display. */
function stripMarkdown(s: string): string {
	return s
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/(^|[^*])\*([^*\n]+)\*(?![*])/g, "$1$2")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Extract the narrative "Executive Summary — Person Brief" paragraph from a
 * finished report — the tight person snapshot the synthesis/live agent writes
 * first. Falls back to the structured summary, then "" if absent. The returned
 * value is plain text (markdown stripped) for terminal display.
 */
export function extractReportBrief(content: string, structured?: StructuredFindings): string {
	const grabAfterHeading = (label: RegExp): string => {
		const m = content.match(label);
		if (!m) return "";
		const start = (m.index ?? 0) + m[0].length;
		const rest = content.slice(start);
		// Stop at the next heading, a horizontal rule, or a blank-line-delimited block.
		const next = rest.search(/\n#{1,6}\s|\n---+\s*\n|\n\*\*\*\s*\n/);
		return (next >= 0 ? rest.slice(0, next) : rest).trim();
	};
	let brief =
		grabAfterHeading(/(^|\n)#{1,6}\s*\d*\.?\s*EXECUTIVE SUMMARY[^\n]*\n+/i) ||
		grabAfterHeading(/(^|\n)#{1,6}\s*[^\n]*PERSON BRIEF[^\n]*\n+/i) ||
		grabAfterHeading(/(^|\n)#{1,6}\s*\d*\.?\s*IDENTITY RESOLUTION[^\n]*\n+/i);
	if (!brief) brief = structured?.summary ?? "";
	return stripMarkdown(brief);
}

/** Merge a secondary GitHub pass into the primary one (alt-lead loop closure). */
function mergeGitHubPass(primary: GitHubPassResult | undefined, extra: GitHubPassResult): GitHubPassResult {
	if (!primary) return extra;
	const seen = new Set(primary.identities.map((i) => i.login.toLowerCase()));
	const identities = [...primary.identities];
	for (const id of extra.identities) {
		const key = id.login.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		identities.push(id);
	}
	return {
		queried: [...new Set([...primary.queried, ...extra.queried])],
		identities,
		rateLimited: primary.rateLimited || extra.rateLimited,
	};
}

/** Merge a secondary web sweep (seeded on a Twitter alt lead) into the primary
 *  sweep result, so the single render/corroboration path sees the whole graph. */
function mergeWebSweep(primary: WebSweepResult, extra: WebSweepResult): WebSweepResult {
	const emails = new Set(primary.identifiers.emails);
	for (const e of extra.identifiers.emails) emails.add(e);

	const seenHandles = new Set(
		primary.identifiers.socialHandles.map((h) => `${h.platform}:${h.handle.toLowerCase()}`),
	);
	const socialHandles = [...primary.identifiers.socialHandles];
	for (const h of extra.identifiers.socialHandles) {
		const key = `${h.platform}:${h.handle.toLowerCase()}`;
		if (seenHandles.has(key)) continue;
		seenHandles.add(key);
		socialHandles.push(h);
	}

	const mergeSources = (
		a: Record<string, string[]> = {},
		b: Record<string, string[]> = {},
	): Record<string, string[]> => {
		const out: Record<string, string[]> = {};
		for (const [k, v] of [...Object.entries(a), ...Object.entries(b)]) {
			const cur = new Set(out[k] ?? []);
			for (const s of v) if (cur.size < 3) cur.add(s);
			out[k] = [...cur];
		}
		return out;
	};

	const bridgeEvidence: NonNullable<WebSweepResult["bridgeEvidence"]> = {
		...(primary.bridgeEvidence ?? {}),
	};
	for (const [owner, entries] of Object.entries(extra.bridgeEvidence ?? {})) {
		const existing = bridgeEvidence[owner] ?? [];
		const seenKeys = new Set(existing.map((e) => `${e.url}|${e.target ?? ""}|${e.kind ?? ""}`));
		const merged = [...existing];
		for (const e of entries) {
			const key = `${e.url}|${e.target ?? ""}|${e.kind ?? ""}`;
			if (seenKeys.has(key)) continue;
			seenKeys.add(key);
			merged.push(e);
		}
		bridgeEvidence[owner] = merged;
	}

	const seenCandidates = new Set(primary.candidates.map((c) => c.url));
	const candidates = [...primary.candidates];
	for (const c of extra.candidates) {
		if (seenCandidates.has(c.url)) continue;
		seenCandidates.add(c.url);
		candidates.push(c);
	}

	return {
		username: primary.username,
		queries: [...new Set([...primary.queries, ...extra.queries])],
		searchResultCount: primary.searchResultCount + extra.searchResultCount,
		candidates,
		identifiers: { emails: [...emails], socialHandles },
		identifierSources: {
			emails: mergeSources(primary.identifierSources?.emails, extra.identifierSources?.emails),
			handles: mergeSources(primary.identifierSources?.handles, extra.identifierSources?.handles),
			freemail: { ...(primary.identifierSources?.freemail ?? {}), ...(extra.identifierSources?.freemail ?? {}) },
		},
		bridgeEvidence,
		snowballSeeds: [...new Set([...(primary.snowballSeeds ?? []), ...(extra.snowballSeeds ?? [])])],
		bridgeOwnerHandles: [...new Set([...(primary.bridgeOwnerHandles ?? []), ...(extra.bridgeOwnerHandles ?? [])])],
		redditProfile: primary.redditProfile,
	};
}

export interface AuditCallbacks {
	onProgress?: (message: string) => void;
	onStatus?: (message: string) => void;
	onToolCall?: (name: string, args: unknown) => void;
	onToolResult?: (name: string, result: unknown) => void;
	onToken?: (text: string) => void;
}

const REPORTS_DIR = join(import.meta.dir, "..", "..", "reports");

/** Save a report to reports/ and return the filepath. */
export function saveReport(username: string, content: string): string {
	mkdirSync(REPORTS_DIR, { recursive: true });
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const filepath = join(REPORTS_DIR, `report_${username}_${ts}.md`);
	const header = [
		`# Reddit De-anonymization Report: u/${username}`,
		`Generated: ${new Date().toISOString()}`,
		"",
	].join("\n");
	writeFileSync(filepath, `${header}${content}\n`);
	return filepath;
}

/** Save a machine-readable JSON report to reports/ and return the filepath. */
export function saveJsonReport(username: string, data: any): string {
	mkdirSync(REPORTS_DIR, { recursive: true });
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const filepath = join(REPORTS_DIR, `report_${username}_${ts}.json`);
	writeFileSync(filepath, JSON.stringify(data, null, 2) + "\n");
	return filepath;
}

/** Ensure JSONL data exists for the user, downloading if necessary. */
async function ensureLocalData(
	username: string,
	years: number,
	dataDir: string,
	onProgress?: (message: string) => void,
): Promise<{ posts: any[]; comments: any[] } | null> {
	const cutoffMs = Date.now() - years * 365.25 * 24 * 60 * 60 * 1000;
	const cutoffSec = Math.floor(cutoffMs / 1000);
	const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);
	const withinWindow = (item: any) => {
		const ts = Number(item?.created_utc ?? 0);
		return ts > 0 && ts >= cutoffSec;
	};

	const loadWindowed = async (dataType: "posts" | "comments") =>
		(await loadJsonlFiles(dataDir, username, dataType).catch(() => [])).filter(withinWindow);
	let posts = await loadWindowed("posts");
	let comments = await loadWindowed("comments");

	if (posts.length > 0 && comments.length > 0) {
		onProgress?.(`[local] Found ${posts.length} posts, ${comments.length} comments since ${cutoffDate} in ${dataDir}`);
		return { posts, comments };
	}

	if (posts.length > 0 || comments.length > 0) {
		const missing = [
			posts.length === 0 ? "posts" : null,
			comments.length === 0 ? "comments" : null,
		].filter(Boolean).join(" and ");
		onProgress?.(`[local] Found partial ${years}yr cache (${posts.length} posts, ${comments.length} comments); downloading missing ${missing}.`);
	} else {
		onProgress?.(`[local] No cached ${years}yr data for u/${username}.`);
	}
	onProgress?.(`[local] Downloading via Arctic Shift...`);
	try {
		await downloadUser(
			username,
			{
				dir: dataDir,
				after: cutoffDate,
				posts: posts.length === 0,
				comments: comments.length === 0,
			},
			onProgress,
		);
	} catch (err: any) {
		onProgress?.(`[local] Download failed: ${err.message}`);
		return null;
	}

	posts = await loadWindowed("posts");
	comments = await loadWindowed("comments");
	if (posts.length === 0 && comments.length === 0) {
		onProgress?.(`[local] Download produced no data; falling back to live agent.`);
		return null;
	}
	onProgress?.(`[local] Ready with ${posts.length} posts, ${comments.length} comments since ${cutoffDate}`);
	return { posts, comments };
}

/** Fallback path when no archive could be downloaded: live tool-driven agent. */
async function runLiveAgent(opts: AuditOptions, callbacks: AuditCallbacks, webContextText = ""): Promise<AuditResult> {
	const { username, years, web, candidate } = opts;
	const log = callbacks.onProgress ?? (() => {});
	const status = callbacks.onStatus ?? (() => {});

	status(`Analyzing u/${username} (live agent)`);
	log(`[agent] Live-agent scan (years=${years}, web=${web})`);

	// Web research: claude-code can use the Firecrawl MCP server natively (no
	// ReAct web tools); openai, codex-cli, pi, and antigravity use our app-owned ReAct web tools.
	// reddit_search stays a ReAct tool on every path (no MCP equivalent).
	const viaMcp = mcpWebPreferred();
	const webAvailable = webToolsAvailable(web);
	if (web && !webAvailable) {
		log(`[web] Firecrawl tools requested but unavailable; continuing with Reddit-only analysis.`);
	}
	const tools = buildRuntimeTools({
		yearsDefault: years,
		enableWeb: webAvailable && !viaMcp,
		log: (message) => {
			status(message);
			log(message);
		},
	});
	const systemPrompt = webAvailable && viaMcp ? `${ANALYST_SYSTEM_PROMPT}${mcpWebNote()}` : ANALYST_SYSTEM_PROMPT;

	const result = await runAgentWithTools({
		systemPrompt,
		userPrompt: buildUserPrompt({ username, years, web: webAvailable, candidate, webContextText }),
		tools,
		maxIterations: 10,
		callbacks: {
			onToolCall: (name, args) => {
				status(`Calling ${name}...`);
				callbacks.onToolCall?.(name, args);
			},
			onToolResult: (name, value) => {
				status(`${name} complete`);
				callbacks.onToolResult?.(name, value);
			},
			onLog: (message) => log(message),
			onToken: (text) => callbacks.onToken?.(text),
		},
	});

	return { content: result.text, toolCalls: result.toolCalls, iterations: result.iterations };
}

/** Run the full audit. */
export async function runAudit(opts: AuditOptions, callbacks: AuditCallbacks = {}): Promise<AuditResult> {
	const { username, years, web, twitter: useTwitter, dataDir, candidate } = opts;
	const log = callbacks.onProgress ?? (() => {});
	const status = callbacks.onStatus ?? (() => {});

	let content = "";
	let toolCalls = 0;
	let iterations = 0;
	// Identifiers are kept STRICTLY SEPARATED by source domain so corroboration
	// counts each observation exactly once (no merge-before-corroboration). The
	// corpus set is the deterministic "direct" domain; the model-mentioned set is
	// never counted as an independent source.
	let corpusIdentifiers: DirectIdentifiers = { emails: [], socialHandles: [] };
	let modelMentionedIdentifiers: DirectIdentifiers = { emails: [], socialHandles: [] };
	let ranDeep = false;
	let structured: StructuredFindings | undefined;
	// Twitter alt-account candidates (e.g. 0xfixture from fixturenew's following list)
	// are the next hop in the alias graph. They feed the ranker even when the
	// web re-probe below is skipped.
	let altLeadHandles: string[] = [];
	// Deterministic age estimates (post-synthesis degree-timeline arithmetic).
	let ageEstimates: AgeEstimate[] = [];
	// Deterministic existence probes + Wayback archive pass (web-gated).
	let existenceProbes: ExistenceProbeResult | undefined;
	let archivePass: ArchivePassResult | undefined;
	// Person-level identity graph (built twice: pre-synthesis for namesake
	// ground truth, post-corpus for the full report block).
	let identityGraph: IdentityGraph | undefined;

	// ── Deterministic web sweep (run EARLY) ──
	// Run before analysis so the synthesis/live agent can REASON about the
	// ground-truth leads (bridge traces, clusters, emails) instead of
	// re-discovering them non-deterministically. The sweep is LLM-free
	// (search+scrape+regex), so it adds little latency.
	let webSweep: WebSweepResult | undefined;
	let webContextText = "";
	let webSweepContextText = "";
	if (web && sweepCapable()) {
		status(`🔎 Deterministic web sweep for u/${username}...`);
		log(`\n🔎 Deterministic web sweep for u/${username}`);
		try {
			webSweep = await runDeterministicWebSweep(username, (msg) => { status(msg); log(msg); });
			webSweepContextText = renderWebContextForPrompt(webSweep);
			webContextText = webSweepContextText;
			if (webContextText) {
				log(`[web-sweep] Injecting ${webSweep.identifiers.emails.length} email(s), ${webSweep.identifiers.socialHandles.length} handle(s), ${Object.keys(webSweep.bridgeEvidence ?? {}).length} bridge lead(s) into analysis as ground truth.`);
			}
		} catch (err: any) {
			log(`[web-sweep] Failed (continuing without ground-truth leads): ${err?.message ?? err}`);
		}
	}

	// ── Deterministic GitHub pass (runs on the sweep's ranked handles) ──
	// The GitHub REST API yields what no scraper reliably gets: real-name
	// fields and git commit-author name+email pairs. Depends only on the
	// audited username + sweep output, NOT on Firecrawl — runs even if the
	// Firecrawl path above failed, as long as --web is set.
	let gitHub: GitHubPassResult | undefined;
	if (web) {
		try {
			const ranked = rankHandles(
				webSweep?.identifiers.socialHandles ?? [],
				username,
				webSweep?.bridgeEvidence,
			);
			// Bridge owner handles (the CURRENT identity from stale cross-references,
			// e.g. fixturenew when the audited user is fixtureveil) are the highest-priority
			// GitHub probes — their profile may expose real name, email, and linked
			// Twitter pointing back to the audited username.
			const seeds = [
				username,
				...(webSweep?.bridgeOwnerHandles ?? []),
				...ranked.filter((r) => r.tier !== "single platform").map((r) => r.handle),
			];
			status(`🐙 GitHub identity pass over ${seeds.length} handle(s)...`);
			gitHub = await runGitHubPass(seeds, {}, (msg) => { status(msg); log(msg); });
			const ghCtx = renderGitHubContextForPrompt(gitHub, username);
			if (ghCtx) {
				webContextText = `${webContextText}${ghCtx}`;
				log(`[github-pass] Injecting ${gitHub.identities.length} GitHub identit(ies) into analysis as ground truth.`);
			}
		} catch (err: any) {
			log(`[github-pass] Failed (continuing without GitHub leads): ${err?.message ?? err}`);
		}
	}

	// ── Deterministic Twitter pass (opt-in --twitter; independent of Firecrawl) ──
	// Runs when --twitter is set AND the operator's twitter-cli reports an
	// authenticated session (status --json → ok:true). Reads profile fields,
	// follow-graph alt-account candidates, and their websites via the burner
	// account — read-only by construction. Seeded with the same ranked handles
	// as the GitHub pass (plus the audited username), so the deepest probes
	// converge on the bridge-owner (current identity) handles.
	let twitter: TwitterPassResult | undefined;
	if (useTwitter) {
		try {
			status(`🐦 Checking twitter-cli availability...`);
			const available = await twitterAvailable();
			if (!available) {
				log(`[twitter-pass] twitter-cli unavailable or unauthenticated — skipping. Install it (uv tool install twitter-cli) and log in with the burner account (TWITTER_AUTH_TOKEN/TWITTER_CT0 env vars or browser cookies).`);
			} else {
				const twSeeds = [
					username,
					...(webSweep?.bridgeOwnerHandles ?? []),
					...rankHandles(
						webSweep?.identifiers.socialHandles ?? [],
						username,
						webSweep?.bridgeEvidence,
					).filter((r) => r.tier !== "single platform").map((r) => r.handle),
				];
				status(`🐦 Twitter identity pass over ${twSeeds.length} handle(s)...`);
				twitter = await runTwitterPass(
					twSeeds,
					{
						subjectCreatedISO: webSweep?.redditProfile?.createdUtc
							? new Date(webSweep.redditProfile.createdUtc * 1000).toISOString()
							: undefined,
					},
					(msg) => { status(msg); log(msg); },
				);
				const twCtx = renderTwitterContextForPrompt(twitter);
				if (twCtx) {
					webContextText = `${webContextText}${twCtx}`;
					log(`[twitter-pass] Injecting ${twitter.results.filter((r) => r.profile).length} profile(s) + ${twitter.results.reduce((n, r) => n + r.altCandidates.length, 0)} alt candidate(s) into analysis as ground truth.`);
				}
			}
		} catch (err: any) {
			log(`[twitter-pass] Failed (continuing without Twitter leads): ${err?.message ?? err}`);
		}
	}

	// ── Alt-lead loop closure ──
	// The Twitter pass's alt-account candidates (0xfixture in fixturenew's following
	// list) are the next hop in the alias graph. Feed them back through the two
	// deterministic passes so the chase doesn't stop at "promising lead" and
	// rely on the LLM to pick it up. Also re-inject any newly found leads into
	// the synthesis/live-agent context.
	if (twitter && twitter.results.length > 0) {
		altLeadHandles = [...new Set(
			twitter.results.flatMap((r) => r.altCandidates.map((a) => a.profile.screenName)),
		)].filter((h) => !h.toLowerCase().startsWith("@"));

		if (altLeadHandles.length > 0) {
			log(`[loop] Alt-lead handles from Twitter follow-graph: [${altLeadHandles.join(", ")}]`);

			// GitHub: probe the alt leads for real-name / commit-email leaks.
			try {
				const extraGh = await runGitHubPass(altLeadHandles, {}, (msg) => { status(msg); log(msg); });
				if (extraGh.identities.length > 0) {
					gitHub = mergeGitHubPass(gitHub, extraGh);
					const ghCtx = renderGitHubContextForPrompt(extraGh, username);
					if (ghCtx) {
						webContextText = `${webContextText}${ghCtx}`;
						log(`[loop] GitHub pass over alt leads found ${extraGh.identities.length} identit(ies).`);
					}
				}
			} catch (err: any) {
				log(`[loop] Alt-lead GitHub pass failed (continuing): ${err?.message ?? err}`);
			}

			// Web sweep: re-sweep each alt lead (single round, no snowball) and
			// merge the identifiers/bridges back into the primary sweep.
			if (web && sweepCapable()) {
				for (const lead of altLeadHandles) {
					try {
						const extraSweep = await runDeterministicWebSweep(lead, (msg) => { status(msg); log(msg); }, { maxRounds: 1 });
						webSweep = webSweep ? mergeWebSweep(webSweep, extraSweep) : extraSweep;
					} catch (err: any) {
						log(`[loop] Alt-lead web sweep failed for ${lead} (continuing): ${err?.message ?? err}`);
					}
				}
				const mergedSweepCtx = webSweep ? renderWebContextForPrompt(webSweep) : "";
				if (mergedSweepCtx) {
					// Replace the original sweep context block with the merged one so
					// the agent sees the expanded graph (rather than appending dupes).
					webContextText = webContextText.replace(webSweepContextText, mergedSweepCtx);
					if (!webContextText.includes(mergedSweepCtx)) {
						webContextText = `${webContextText}${mergedSweepCtx}`;
					}
					webSweepContextText = mergedSweepCtx;
				}
			}
		}
	}

	// ── Deterministic existence probes + Wayback archive pass (web-gated) ──
	// Profile-existence probes catch platforms search engines never index;
	// the CDX archive pass catches pre-rename/defunct profiles (snapshots that
	// predate the subject's cake day). Both are LEADS — existence ≠ same
	// person — injected as context and rendered as report blocks. Seeded with
	// the sweep's top-tier handles (bridge owners first), capped internally.
	if (web) {
		const probeSeeds = [...new Set([
			...(webSweep?.bridgeOwnerHandles ?? []),
			...rankHandles(
				webSweep?.identifiers.socialHandles ?? [],
				username,
				webSweep?.bridgeEvidence,
			).filter((r) => r.tier !== "single platform").map((r) => r.handle),
		])];
		const subjectCreatedUtc = webSweep?.redditProfile?.createdUtc;
		try {
			status(`📡 Username existence probes over ${Math.min(3, probeSeeds.length)} handle(s)...`);
			existenceProbes = await runExistenceProbes(probeSeeds, {}, (msg) => { status(msg); log(msg); });
			const hits = existenceProbes.probes.filter((p) => p.outcome === "exists").length;
			if (hits > 0) log(`[probes] ${hits} profile(s) exist for probed handles.`);
			const ctx = renderExistenceProbeContextForPrompt(existenceProbes);
			if (ctx) webContextText = `${webContextText}${ctx}`;
		} catch (err: any) {
			log(`[probes] Existence probes failed (continuing): ${err?.message ?? err}`);
		}
		try {
			status(`🕰️ Wayback archive pass over top handle(s)...`);
			archivePass = await runArchivePass(probeSeeds, { subjectCreatedUtc }, (msg) => { status(msg); log(msg); });
			if (archivePass.snapshots.length > 0) {
				log(`[archive] ${archivePass.snapshots.length} archived profile URL(s) found.`);
				const ctx = renderArchiveContextForPrompt(archivePass, subjectCreatedUtc);
				if (ctx) webContextText = `${webContextText}${ctx}`;
			}
		} catch (err: any) {
			log(`[archive] Archive pass failed (continuing): ${err?.message ?? err}`);
		}
	}

	// ── Identity graph, pre-synthesis build (namesake ground truth) ──
	// Built from the deterministic passes only (no corpus yet): the synthesis
	// agent learns which handles fuse into the SUBJECT person and which are
	// provably separate (namesakes) before it writes Identity Resolution.
	try {
		const preGraph = buildIdentityGraph({ username, webSweep, gitHub, twitter });
		const ctx = renderIdentityGraphContextForPrompt(preGraph, username);
		if (ctx) {
			webContextText = `${webContextText}${ctx}`;
			log(`[graph] Pre-synthesis identity graph: ${preGraph.persons.length} person entit(ies) injected as ground truth.`);
		}
	} catch (err: any) {
		log(`[graph] Pre-synthesis identity graph failed (continuing): ${err?.message ?? err}`);
	}

	// ── Sub-agent ground-truth injection ──
	// Compact digest of the deterministic leads (bridge owners, clusters,
	// emails, GitHub/Twitter leaks) so all three domain sub-agents can connect
	// corpus evidence to verified anchors — only the synthesis agent saw these
	// before. Swallowed on failure: the digest is an enhancement, never a gate.
	let subAgentLeadsText = "";
	try {
		subAgentLeadsText = renderSubAgentLeadsDigest({ username, webSweep, gitHub, twitter });
		if (subAgentLeadsText) {
			log(`[leads] Injecting deterministic leads digest into all three sub-agents (${subAgentLeadsText.length} chars).`);
		}
	} catch (err: any) {
		log(`[leads] Digest failed (continuing without): ${err?.message ?? err}`);
	}

	status(`Preparing deep scan for u/${username}...`);
	const local = await ensureLocalData(username, years, dataDir, log);

	// ── Deterministic posting-time timezone estimate (needs the corpus) ──
	// Sleep-window fit over created_utc: the UTC offset whose local 01:00–07:00
	// window holds the least activity. Medium/high-confidence fits are injected
	// into the agent context as ground truth so the synthesis corroborates
	// location claims against the clock instead of eyeballing timestamps; the
	// block itself is always rendered (it carries its own confidence + caveat).
	let timezone: TimezoneEstimate | null = null;
	if (local) {
		const stamps = [...local.posts, ...local.comments]
			.map((x: any) => Number(x?.created_utc))
			.filter((t: number) => Number.isFinite(t) && t > 0);
		timezone = estimateUtcOffset(stamps);
		if (timezone) {
			log(`[timezone] Posting-time fit: ${timezone.label} (confidence ${timezone.confidence}, ${timezone.postCount} items).`);
			if (timezone.confidence !== "low") {
				webContextText = `${webContextText}\n${renderTimezoneContextForPrompt(timezone)}\n`;
			}
		}
	}

	if (local) {
		log(`\n🔬 Multi-Agent Deep Analysis: ${local.posts.length} posts + ${local.comments.length} comments\n`);
		const result = await runDeepAnalysis(username, local.posts, local.comments, candidate, (msg) => {
			status(msg);
			log(msg);
		}, {
			web: opts.web,
			webContextText,
			subAgentLeadsText,
			// Ground-truth handles from the deterministic passes feed the relevance
			// ranker — items mentioning these survive the per-domain cap.
			knownHandles: [
				...(webSweep?.bridgeOwnerHandles ?? []),
				...(webSweep?.identifiers.socialHandles ?? []).map((h) => h.handle),
				...(gitHub?.identities ?? []).map((i) => i.login),
				...altLeadHandles,
			],
		});
		content = formatDeepAnalysisReport(result);
		toolCalls = 0;
		iterations = result.subAgentResults.length;
		corpusIdentifiers = result.directIdentifiers;
		modelMentionedIdentifiers = result.modelMentionedIdentifiers;
		ranDeep = true;
		structured = result.structured;
		log(`\n📄 Deep analysis complete — ${result.subAgentResults.length} sub-agents in ${(result.stats.total_duration_ms / 1000).toFixed(1)}s`);
	} else {
		log(`[deep] No local data; falling back to live agent scan...`);
		const live = await runLiveAgent(opts, callbacks, webContextText);
		content = live.content;
		toolCalls = live.toolCalls;
		iterations = live.iterations;
	}

	// ── Identifier collections, kept strictly separated by source domain ──
	// Built once here so rendering and corroboration share one source of truth.
	// Crucially corroboration consumes corpus/web/github as DISTINCT inputs —
	// they are NOT merged into the corpus set (that was the corroboration
	// double-count: one GitHub observation counted as both "direct" and "github").
	const identifierCollections: IdentifierCollections = {
		corpus: corpusIdentifiers,
		web: webSweep?.identifiers ?? { emails: [], socialHandles: [] },
		github: gitHub && gitHub.identities.length > 0 ? gitHubIdentifiers(gitHub) : { emails: [], socialHandles: [] },
		twitter: twitter ? twitterIdentifiers(twitter) : { emails: [], socialHandles: [] },
		modelMentioned: modelMentionedIdentifiers,
	};
	// Display projection: corpus + web + github (deterministic). Model-mentioned
	// identifiers are intentionally excluded from this headline set.
	const directIdentifiers = mergeIdentifiersForDisplay(identifierCollections);

	// Live fallback path has no raw corpus in hand. Identifiers extracted
	// from the report text are MODEL-MENTIONED (unverified) — never treated as
	// deterministic and never counted as an independent corroboration source.
	// (The deep path already produced + rendered corpus identifiers and ran the
	// structured-findings pass inside runDeepAnalysis.)
	if (!ranDeep) {
		modelMentionedIdentifiers = extractDirectIdentifiers([content], username);
		identifierCollections.modelMentioned = modelMentionedIdentifiers;
		if (!structured) {
			try {
				structured = await extractStructuredFindings(content, corpusIdentifiers, username, log);
				structured = validateStructuredFindings(structured); // shape-only — no corpus in standard path
				if (structured) content = `${content}\n\n---\n${renderStructuredFindings(structured)}`;
			} catch (err: any) {
				log(`[findings] Structured extraction failed: ${err?.message ?? err}`);
			}
		}
		// Render deterministic corpus identifiers + model-mentioned identifiers
		// (deduped against the FULL deterministic set, so a value confirmed by
		// the web sweep / GitHub pass isn't also flagged "unverified").
		const detBlock = renderDirectIdentifiersBlock(corpusIdentifiers);
		const modelBlock = renderModelMentionedBlock(modelMentionedIdentifiers, directIdentifiers);
		if (detBlock || modelBlock) {
			const top = [detBlock, modelBlock].filter(Boolean).join("\n\n---\n");
			content = `${top}\n---\n${content}`;
		}
	}

	// ── Render the deterministic web sweep + GitHub pass (already run above) ──
	// They ran before analysis so the synthesis/live agent could reason about
	// their ground-truth leads.
	if (webSweep) content = `${renderWebSweepBlock(webSweep)}${content}`;
	if (timezone) content = `${renderTimezoneBlock(timezone)}${content}`;
	if (gitHub && gitHub.identities.length > 0) content = `${renderGitHubBlock(gitHub)}${content}`;
	if (twitter) content = `${renderTwitterBlock(twitter)}${content}`;
	if (existenceProbes) content = `${renderExistenceProbeBlock(existenceProbes)}${content}`;
	if (archivePass) content = `${renderArchiveBlock(archivePass, webSweep?.redditProfile?.createdUtc)}${content}`;

	// ── Deterministic age estimate (post-synthesis, over the report's own claims) ──
	// Degree-timeline arithmetic the narrative cannot contradict: parse the
	// education milestones the report itself claims, apply the enrollment-age
	// norms as code, and append the computed block. Same `now` drives estimate
	// and render so the ranges stay internally consistent.
	try {
		const ageAsOf = new Date();
		const claimTexts = [
			content,
			...(structured?.findings ?? []).map((f) => `${f.claim} ${f.rationale}`),
		];
		ageEstimates = estimateAges(claimTexts, ageAsOf);
		if (ageEstimates.length > 0) {
			const block = renderAgeBlock(ageEstimates, ageAsOf);
			content = `${content}\n\n---\n${block}`;
			log(`[age] ${ageEstimates.length} deterministic estimate(s); tightest age range ${ageEstimates[0].ageRange.join("-")}.`);
		}
	} catch (err: any) {
		log(`[age] Deterministic age pass failed (continuing): ${err?.message ?? err}`);
	}

	// Raw pre-filter item texts shared by corroboration + the identity graph:
	// a verbatim word-boundary handle mention on Reddit is a reddit-domain
	// source for that handle's cluster and a disclosure edge in the graph.
	const corpusItems = local
		? [
			...local.posts.map((p: any) => ({ text: `${p?.title ?? ""} ${p?.selftext ?? ""}`.trim(), permalink: p?.permalink })),
			...local.comments.map((c: any) => ({ text: c?.body ?? "", permalink: c?.permalink })),
		]
		: undefined;

	// ── Cross-signal corroboration (deterministic fusion over ALL sources) ──
	// Runs last. Crucially it receives the CORPUS-ONLY direct set plus the web
	// sweep and GitHub pass as DISTINCT inputs — so each underlying observation
	// is counted under exactly one domain, never two. Pure + never throws.
	let corroboration: CorroborationResult | undefined;
	try {
		corroboration = computeCorroboration({
			username,
			structured,
			directIdentifiers: corpusIdentifiers,
			webSweep,
			gitHub,
			twitter,
			corpusTexts: corpusItems,
		});
		const block = renderCorroborationBlock(corroboration);
		if (block) content = `${content}\n\n---\n${block}`;

		// Reconcile overallRisk: the corroboration layer is the deterministic
		// authority on triangulation. Take the STRONGER of the LLM's risk and
		// the corroboration risk so a calibrated cross-domain match can only
		// raise, not silently lower, the headline risk.
		if (structured) {
			structured = {
				...structured,
				overallRisk: maxRisk(structured.overallRisk, corroboration.overallRisk),
			};
		}
		log(`[corroboration] ${corroboration.clusters.length} cluster(s), risk=${corroboration.overallRisk}, score=${corroboration.score}, ${corroboration.contradictions.length} contradiction(s). Verdict: exposure=${corroboration.verdict.exposureSeverity}, attribution=${corroboration.verdict.attributionConfidence}, evidence-quality=${corroboration.verdict.evidenceQuality}.`);
	} catch (err: any) {
		log(`[corroboration] Failed (continuing without corroboration layer): ${err?.message ?? err}`);
	}

	// ── Identity graph, full build (post-corpus: disclosure edges included) ──
	// Fuses rename/cluster/drift/disclosure/email/name edges into person
	// entities: the subject person (handles + emails + names + confidence) and
	// the namesake candidates the graph says are NOT the subject.
	try {
		identityGraph = buildIdentityGraph({
			username,
			webSweep,
			gitHub,
			twitter,
			corpusIdentifiers,
			corpusTexts: corpusItems,
		});
		const block = renderIdentityGraphBlock(identityGraph, username);
		if (block) content = `${content}\n\n---\n${block}`;
		const subject = identityGraph.persons.find((p) => p.isSubject);
		log(`[graph] ${identityGraph.persons.length} person entit(ies); subject confidence=${subject?.confidence ?? "n/a"} with ${subject?.handleNodes.length ?? 0} handle(s).`);
	} catch (err: any) {
		log(`[graph] Identity graph failed (continuing): ${err?.message ?? err}`);
	}

	const json = {
		username,
		mode: ranDeep ? `deep:${years}yr` : "live-fallback",
		web,
		twitter: !!useTwitter,
		timezone,
		ageEstimates,
		existenceProbes,
		archivePass,
		identityGraph,
		candidate: candidate?.name,
		identifierCollections,
		directIdentifiers,
		modelMentionedIdentifiers,
		structured,
		corroboration,
		verdict: corroboration?.verdict,
		content,
	};

	const brief = extractReportBrief(content, structured);

	return {
		content,
		toolCalls,
		iterations,
		directIdentifiers,
		modelMentionedIdentifiers,
		identifierCollections,
		structured,
		corroboration,
		verdict: corroboration?.verdict,
		brief,
		json,
	};
}
