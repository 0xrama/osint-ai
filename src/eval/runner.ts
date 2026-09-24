/**
 * Evaluation runner — orchestrates fixtures against deterministic layers.
 *
 * For each fixture:
 *   1. Build injectable deps (sweep + github) from the fixture inputs.
 *   2. Run the web sweep deterministically.
 *   3. Run the GitHub pass deterministically.
 *   4. Run corpus extraction (if Reddit history present).
 *   5. Build findings + corroboration.
 *   6. Score against ground truth → EvalMetrics.
 *
 * Network-free. All dependencies injected.
 */

import type { EvalFixture, EvalMetrics, AggregateMetrics } from "./schema.ts";
import { buildSweepDeps, scoreIdentifiers, scoreBridges, scoreHandleAttribution, scoreAttribution, scoreContradictions, computePRF1, aggregateMetrics } from "./schema.ts";
import { runDeterministicWebSweep } from "../analysis/web-sweep.ts";
import { runGitHubPass, buildGitHubDepsFromFixture, gitHubIdentifiers } from "../analysis/github-pass.ts";
import { extractDirectIdentifiers, type DirectIdentifiers } from "../analysis/extract.ts";
import { buildCorpusManifest, validateStructuredFindings } from "../analysis/findings.ts";
import { computeCorroboration } from "../analysis/corroboration.ts";
import type { WebSweepResult } from "../analysis/web-sweep.ts";
import type { GitHubPassResult } from "../analysis/github-pass.ts";

/**
 * Run one fixture through the full deterministic pipeline.
 * Catches errors per-fixture so one bad fixture never aborts the suite.
 */
async function runFixture(fixture: EvalFixture): Promise<{ metrics: EvalMetrics | null; error?: string }> {
  const { inputs, groundTruth, id } = fixture;
  try {
    // 1. Web sweep (deterministic, DI) — only if fixture carries search/scrape data
    let sweep: WebSweepResult;
    if (Object.keys(inputs.searchResults).length > 0 || Object.keys(inputs.scrapedPages).length > 0) {
      const sweepDeps = buildSweepDeps(inputs);
      sweep = await runDeterministicWebSweep(
        inputs.username,
        () => {}, // silent progress
        { maxScrapes: 10, maxRounds: 2, deps: sweepDeps },
      );
    } else {
      sweep = {
        username: inputs.username,
        queries: [],
        searchResultCount: 0,
        candidates: [],
        identifiers: { emails: [], socialHandles: [] },
      };
    }

    // 2. GitHub pass (deterministic, DI)
    let gitHub: GitHubPassResult | null = null;
    const seeds = [
      inputs.username,
      ...(sweep.bridgeOwnerHandles ?? []),
      ...sweep.identifiers.socialHandles.map((h) => h.handle),
    ];
    if (Object.keys(inputs.githubProfiles).length > 0) {
      const ghDeps = buildGitHubDepsFromFixture(inputs.githubProfiles, inputs.githubCommits);
      gitHub = await runGitHubPass(
        [...new Set(seeds)],
        { maxSeeds: 5, reposPerUser: 3, deps: ghDeps },
      );
    }

    // 3. Corpus identifiers (from Reddit history if present)
    let corpusIds: DirectIdentifiers = { emails: [], socialHandles: [] };
    if (inputs.redditHistory && inputs.redditHistory.length > 0) {
      const manifest = buildCorpusManifest(inputs.redditHistory);
      corpusIds = extractDirectIdentifiers(manifest.texts, inputs.username);
    }

    // 4. Web identifiers from the sweep
    const webIds = sweep.identifiers;

    // 5. GitHub identifiers
    const githubIds = gitHub && gitHub.identities.length > 0
      ? gitHubIdentifiers(gitHub)
      : { emails: [], socialHandles: [] };

    // 6. Corroboration (deterministic, no LLM)
    const corroboration = computeCorroboration({
      username: inputs.username,
      directIdentifiers: corpusIds,
      webSweep: sweep,
      gitHub: gitHub ?? undefined,
    });

    // 7. Build StructuredFindings from fixture-supplied findings (LLM mock)
    //    so the eval path can exercise contradiction detection without an LLM.
    const fixtureFindings = inputs.findings ?? [];
    const sfFindings = fixtureFindings.map((f: any) => ({
      category: f.category,
      claim: f.claim,
      confidence: f.confidence ?? "medium",
      rationale: "fixture",
      evidence: (f.evidence ?? []).map((e: any) => ({ quote: e.quote, permalink: e.permalink })),
      remediation: "",
    }));
    // Build a corpus manifest from Reddit history to validate findings evidence.
    const corpusManifest = inputs.redditHistory && inputs.redditHistory.length > 0
      ? buildCorpusManifest(inputs.redditHistory)
      : undefined;
    const structured = validateStructuredFindings(
      {
        overallRisk: "medium",
        summary: `Eval: ${id}`,
        findings: sfFindings,
      },
      corpusManifest,
    );

    // Re-run corroboration with the mock findings if the fixture provides them.
    const finalCorroboration = sfFindings.length > 0
      ? computeCorroboration({
          username: inputs.username,
          structured,
          directIdentifiers: corpusIds,
          webSweep: sweep,
          gitHub: gitHub ?? undefined,
        })
      : corroboration;

    // 8. Score against ground truth
    const allId = mergeIdentifierSets([corpusIds, webIds, githubIds]);
    const idScore = scoreIdentifiers(allId, groundTruth);
    const { precision: idPrec, recall: idRec, f1: idF1 } = computePRF1(idScore.tp, idScore.fp, idScore.fn);

    const bridgeScore = scoreBridges(sweep.bridgeOwnerHandles, groundTruth);
    const { precision: bridgePrec, recall: bridgeRec } = computePRF1(
      bridgeScore.tp, bridgeScore.fp, bridgeScore.fn,
    );

    const handleAttr = scoreHandleAttribution(mergeIdentifierSets([webIds, githubIds]), groundTruth);
    const candidateLinkPrecision = handleAttr.tp.length + handleAttr.fp.length > 0
      ? handleAttr.tp.length / (handleAttr.tp.length + handleAttr.fp.length)
      : 1.0;

    // Citation validity: if the fixture has findings with evidence and a
    // corpus, the validation pass already dropped unsupported entries.
    const ev = structured.evidenceValidation;
    const citationValidityRate = ev && ev.checked > 0
      ? ev.supported / ev.checked
      : 1.0;

    const attribution = scoreAttribution(finalCorroboration, groundTruth);
    const contradiction = scoreContradictions(finalCorroboration.contradictions, groundTruth);

    const metrics: EvalMetrics = {
      fixtureId: id,
      identifierPrecision: idPrec,
      identifierRecall: idRec,
      identifierF1: idF1,
      citationValidityRate,
      bridgePrecision: bridgePrec,
      bridgeRecall: bridgeRec,
      bridgeFalsePositiveRate: bridgeScore.fp.length / Math.max(1, bridgeScore.tp.length + bridgeScore.fp.length),
      candidateLinkPrecision,
      attributionTop1Correct: attribution.top1Correct,
      attributionTopKCorrect: attribution.topKCorrect,
      contradictionCorrect: contradiction.correct,
      truePositives: idScore.tp,
      falsePositives: idScore.fp,
      falseNegatives: idScore.fn,
    };

    return { metrics };
  } catch (err: any) {
    return { metrics: null, error: `${id}: ${err?.message ?? String(err)}` };
  }
}

function mergeIdentifierSets(sets: DirectIdentifiers[]): DirectIdentifiers {
  const emails = new Set<string>();
  const handleKeys = new Set<string>();
  const handles: DirectIdentifiers["socialHandles"] = [];
  for (const di of sets) {
    for (const e of di.emails) emails.add(e);
    for (const h of di.socialHandles) {
      const k = `${h.platform}:${h.handle.toLowerCase()}`;
      if (handleKeys.has(k)) continue;
      handleKeys.add(k);
      handles.push(h);
    }
  }
  return { emails: [...emails], socialHandles: handles };
}

/** Run all fixtures and produce an aggregated report. */
export async function runEvalSuite(
  fixtures: EvalFixture[],
  options?: { fixtures?: EvalFixture[] },
): Promise<AggregateMetrics> {
  const toRun = options?.fixtures ?? fixtures;
  const metrics: EvalMetrics[] = [];
  const errors: Array<{ fixtureId: string; error: string }> = [];
  const catCoverage: Record<string, number> = {};

  for (const fixture of toRun) {
    const { metrics: m, error } = await runFixture(fixture);
    if (m) {
      metrics.push(m);
      for (const cat of fixture.categories) {
        catCoverage[cat] = (catCoverage[cat] ?? 0) + 1;
      }
    }
    if (error) errors.push({ fixtureId: fixture.id, error });
  }

  const ag = aggregateMetrics(metrics);
  ag.categoryCoverage = catCoverage;
  ag.failures = errors;
  return ag;
}

/** Format aggregated metrics as a human-readable report string. */
export function formatEvalReport(ag: AggregateMetrics): string {
  const lines: string[] = [];
  lines.push("# Eval Report");
  lines.push("");
  lines.push(`**Fixtures**: ${ag.fixtureCount} total, ${ag.failures.length} failure(s)`);
  lines.push("");
  lines.push("## Category coverage");
  for (const [cat, count] of Object.entries(ag.categoryCoverage).sort()) {
    lines.push(`- ${cat}: ${count}`);
  }
  lines.push("");
  lines.push("## Aggregate metrics");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Mean identifier F1 | ${(ag.meanIdentifierF1 * 100).toFixed(1)}% |`);
  lines.push(`| Mean citation validity rate | ${(ag.meanCitationValidity * 100).toFixed(1)}% |`);
  lines.push(`| Mean bridge F1 | ${(ag.meanBridgeF1 * 100).toFixed(1)}% |`);
  lines.push(`| Mean candidate-link precision | ${(ag.meanCandidateLinkPrecision * 100).toFixed(1)}% |`);
  lines.push(`| Attribution top-1 rate | ${(ag.attributionTop1Rate * 100).toFixed(1)}% |`);
  lines.push(`| Contradiction accuracy | ${(ag.contradictionAccuracy * 100).toFixed(1)}% |`);
  lines.push("");
  lines.push("## Per-fixture details");
  lines.push("");
  lines.push(`| Fixture | ID F1 | Bridge F1 | Link Prec | Top-1 | Contra |`);
  lines.push(`|---------|-------|-----------|-----------|-------|--------|`);
  for (const m of ag.perFixture) {
    lines.push(
      `| ${m.fixtureId} | ${(m.identifierF1 * 100).toFixed(0)}% | ${(m.bridgePrecision + m.bridgeRecall > 0 ? ((2 * m.bridgePrecision * m.bridgeRecall) / (m.bridgePrecision + m.bridgeRecall) * 100).toFixed(0) : 0)}% | ${(m.candidateLinkPrecision * 100).toFixed(0)}% | ${m.attributionTop1Correct ? "✓" : "✗"} | ${m.contradictionCorrect ? "✓" : "✗"} |`,
    );
  }

  if (ag.failures.length > 0) {
    lines.push("");
    lines.push("## Failures");
    for (const f of ag.failures) {
      lines.push(`- **${f.fixtureId}**: ${f.error}`);
    }
  }

  return lines.join("\n");
}
