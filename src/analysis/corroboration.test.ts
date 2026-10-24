import { describe, expect, test } from "bun:test";
import {
  calibrateConfidence,
  checkCandidateHypothesis,
  clamp,
  computeCorroboration,
  mapOverallRisk,
  maxRisk,
  nameTokens,
  normalizeEmployer,
  normalizeLocation,
  normalizeName,
  parseAge,
  renderCandidateHypothesisBlock,
  renderCorroborationBlock,
} from "./corroboration.ts";
import type { CorroborationInput, CorroborationResult, CorroborationCluster } from "./corroboration.ts";
import type { StructuredFindings, Finding } from "./findings.ts";
import type { SocialHandle } from "./extract.ts";
import type { WebSweepResult } from "./web-sweep.ts";
import type { GitHubPassResult, GitHubIdentity } from "./github-pass.ts";
import type { TwitterPassResult, TwitterUserProfile } from "./twitter-pass.ts";
import { buildIdentityGraph } from "./identity-graph.ts";

/* ── Fixture builders (no network, no LLM) ─────────────────────────────── */

const NOW = new Date("2026-08-07T00:00:00Z");

function mkFinding(
  category: Finding["category"],
  claim: string,
  permalinks: string[] = [],
  confidence: Finding["confidence"] = "medium",
): Finding {
  return {
    category,
    claim,
    confidence,
    rationale: "test",
    evidence: permalinks.map((p) => ({ quote: "", permalink: p })),
    remediation: "test",
  };
}

function mkStructured(findings: Finding[], risk: "low" | "medium" | "high" = "low"): StructuredFindings {
  return { overallRisk: risk, summary: "test", findings };
}

function mkHandle(platform: string, handle: string, url: string): SocialHandle {
  return { platform, handle, url };
}

function mkGitHubIdentity(partial: Partial<GitHubIdentity> & { login: string }): GitHubIdentity {
  return {
    login: partial.login,
    url: `https://github.com/${partial.login}`,
    commitAuthors: [],
    commitStats: { scanned: 0, attributed: 0, excluded: 0 },
    ...partial,
  };
}

function mkGitHub(identities: GitHubIdentity[]): GitHubPassResult {
  return { queried: identities.map((i) => i.login), identities, rateLimited: false };
}

function mkWebSweep(partial: Partial<WebSweepResult> = {}): WebSweepResult {
  return {
    username: "testuser",
    queries: [],
    searchResultCount: 0,
    candidates: [],
    identifiers: { emails: [], socialHandles: [] },
    ...partial,
  };
}

function run(input: Partial<CorroborationInput>): CorroborationResult {
  return computeCorroboration(
    {
      username: "target_user",
      ...input,
    },
    { now: NOW },
  );
}

/* ── Pure helpers ──────────────────────────────────────────────────────── */

describe("normalization helpers", () => {
  test("normalizeLocation keeps the head token before a comma", () => {
    expect(normalizeLocation("Hyderabad, India")).toBe("hyderabad");
    expect(normalizeLocation("  New Delhi ")).toBe("new delhi");
    expect(normalizeLocation("Uppal, Hyderabad, Telangana")).toBe("uppal");
  });

  test("normalizeEmployer strips @, suffixes, and case", () => {
    expect(normalizeEmployer("@Acme Inc.")).toBe("acme");
    expect(normalizeEmployer("Acme Ltd")).toBe("acme");
    expect(normalizeEmployer("  GlobalCorp LLC ")).toBe("globalcorp");
    expect(normalizeEmployer("Boring Company")).toBe("boring company");
  });

  test("normalizeName collapses punctuation/whitespace", () => {
    expect(normalizeName("John A. Doe")).toBe("john a doe");
    expect(normalizeName("  Jane—Smith ")).toBe("jane smith");
  });

  test("nameTokens drops short tokens and dedupes", () => {
    expect(nameTokens("John A. Doe")).toEqual(["john", "doe"]);
    expect(nameTokens("John Doe John")).toEqual(["john", "doe"]);
  });

  test("parseAge handles integers, ranges, decades", () => {
    expect(parseAge("19")).toBe(19);
    expect(parseAge("about 19")).toBe(19);
    expect(parseAge("19-21")).toEqual([19, 21]);
    expect(parseAge("19 or 20")).toEqual([19, 20]);
    expect(parseAge("mid-20s")).toBe(22);
    expect(parseAge("late 20s")).toBe(24);
    expect(parseAge("I am old")).toBeNull();
  });

  test("clamp bounds", () => {
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(50, 0, 100)).toBe(50);
  });
});

/* ── Calibration ───────────────────────────────────────────────────────── */

describe("calibrateConfidence", () => {
  test("single unsourced finding is low", () => {
    const r = calibrateConfidence({ reddit_evidence: 1, web: 0, github: 0, direct: 0 });
    expect(r.confidence).toBe("low");
    expect(r.independentSources).toBe(1);
    expect(r.domainCount).toBe(1);
  });

  test("single-domain 3 permalinks is medium (repetition != independence)", () => {
    const r = calibrateConfidence({ reddit_evidence: 3, web: 0, github: 0, direct: 0 });
    expect(r.confidence).toBe("medium");
  });

  test("two domains (1+1) is medium", () => {
    const r = calibrateConfidence({ reddit_evidence: 1, web: 0, github: 1, direct: 0 });
    expect(r.confidence).toBe("medium");
    expect(r.independentSources).toBe(2);
    expect(r.domainCount).toBe(2);
  });

  test("two domains with depth (2+2) is high", () => {
    const r = calibrateConfidence({ reddit_evidence: 2, web: 0, github: 2, direct: 0 });
    expect(r.confidence).toBe("high");
  });

  test("extra bonus can push a band up", () => {
    const base = { reddit_evidence: 1, web: 1, github: 0, direct: 0 };
    expect(calibrateConfidence(base).confidence).toBe("medium");
    expect(calibrateConfidence(base, 1).confidence).toBe("medium");
    expect(calibrateConfidence({ reddit_evidence: 2, web: 1, github: 0, direct: 0 }, 1).confidence).toBe("high");
  });

  test("caps prevent saturation", () => {
    const r = calibrateConfidence({ reddit_evidence: 99, web: 0, github: 0, direct: 0 });
    expect(r.independentSources).toBe(3);
  });
});

/* ── Clustering ────────────────────────────────────────────────────────── */

describe("clustering", () => {
  test("exact handle clustering is separator-tolerant across domains", () => {
    const res = run({
      directIdentifiers: { emails: [], socialHandles: [mkHandle("x", "john.doe", "https://x.com/john.doe")] },
      webSweep: mkWebSweep({
        identifiers: { emails: [], socialHandles: [mkHandle("instagram", "john_doe", "https://instagram.com/john_doe")] },
        identifierSources: { emails: {}, handles: { "instagram:johndoe": ["https://example.org/john"] }, freemail: {} },
      }),
      gitHub: mkGitHub([mkGitHubIdentity({ login: "johndoe" })]),
    });
    const handles = res.clusters.filter((c) => c.signalType === "handle");
    expect(handles.length).toBe(1);
    const h = handles[0];
    expect(h.domainCount).toBe(3);
    // One cited web document + GitHub profile + corpus extraction.
    expect(h.sourceBreakdown.web).toBe(1);
    expect(h.sourceBreakdown.github).toBe(1);
    expect(h.sourceBreakdown.direct).toBe(1);
  });

  test("audited username handle is dropped", () => {
    const res = run({
      directIdentifiers: { emails: [], socialHandles: [mkHandle("github", "target_user", "https://github.com/target_user")] },
    });
    expect(res.clusters.filter((c) => c.signalType === "handle")).toEqual([]);
  });

  test("reserved seed word produces no cluster (via rankHandles)", () => {
    const res = run({
      webSweep: mkWebSweep({
        identifiers: { emails: [], socialHandles: [mkHandle("github", "github", "https://github.com/github")] },
      }),
    });
    expect(res.clusters.filter((c) => c.signalType === "handle")).toEqual([]);
  });

  test("email exact clustering + noreply drop", () => {
    const res = run({
      directIdentifiers: { emails: ["jane@acme.com"], socialHandles: [] },
      webSweep: mkWebSweep({
        identifiers: { emails: ["jane@acme.com"], socialHandles: [] },
        identifierSources: {
          emails: { "jane@acme.com": ["https://example.com/about"] },
          handles: {},
          freemail: { "jane@acme.com": false },
        },
      }),
      gitHub: mkGitHub([
        mkGitHubIdentity({ login: "jane", email: "jane@acme.com" }),
        mkGitHubIdentity({ login: "bot", email: "", commitAuthors: [{ name: "Bot", email: "bot@users.noreply.github.com", repo: "bot/repo", attributedLogin: "bot" }] }),
      ]),
    });
    const emails = res.clusters.filter((c) => c.signalType === "email");
    expect(emails.length).toBe(1);
    expect(emails[0].value).toBe("jane@acme.com");
    expect(emails[0].domainCount).toBe(3);
    expect(emails[0].corroborating).toBe(true);
  });

  test("location fuzzy containment merges finding + GitHub", () => {
    const res = run({
      structured: mkStructured([mkFinding("location", "lives in Hyderabad", ["https://reddit.com/r/hyderabad/abc"])]),
      gitHub: mkGitHub([mkGitHubIdentity({ login: "jane", location: "Hyderabad, India" })]),
    });
    const locs = res.clusters.filter((c) => c.signalType === "location");
    expect(locs.length).toBe(1);
    expect(locs[0].value).toBe("Hyderabad, India"); // longer surface form wins
    expect(locs[0].sourceBreakdown.reddit_evidence).toBe(1);
    expect(locs[0].sourceBreakdown.github).toBe(1);
    expect(locs[0].domainCount).toBe(2);
    expect(locs[0].corroborating).toBe(true);
  });

  test("employer suffix normalization merges finding + GitHub", () => {
    const res = run({
      structured: mkStructured([mkFinding("employer_or_school", "works at Acme", ["https://reddit.com/r/jobs/1"])]),
      gitHub: mkGitHub([mkGitHubIdentity({ login: "jane", company: "@Acme Inc." })]),
    });
    const emp = res.clusters.filter((c) => c.signalType === "employer");
    expect(emp.length).toBe(1);
    expect(emp[0].value).toBe("Acme Inc.");
    expect(emp[0].domainCount).toBe(2);
  });

  test("real_name token overlap merges finding + GitHub profile + commit authors", () => {
    const res = run({
      structured: mkStructured([mkFinding("real_name", "John Doe", ["https://reddit.com/r/askreddit/1"])]),
      gitHub: mkGitHub([
        mkGitHubIdentity({
          login: "jdoe",
          name: "John A. Doe",
          commitAuthors: [
            { name: "John Doe", email: "john@acme.com", repo: "jdoe/repo1", attributedLogin: "jdoe" },
            { name: "John Doe", email: "john@acme.com", repo: "jdoe/repo2", attributedLogin: "jdoe" },
          ],
        }),
      ]),
    });
    const names = res.clusters.filter((c) => c.signalType === "real_name");
    expect(names.length).toBe(1);
    expect(names[0].value).toBe("John A. Doe"); // fullest name wins
    expect(names[0].sourceBreakdown.github).toBe(3); // field + 2 repos (capped)
    expect(names[0].domainCount).toBe(2);
    expect(names[0].corroborating).toBe(true);
  });

  test("disjoint locations stay separate clusters", () => {
    const res = run({
      structured: mkStructured([
        mkFinding("location", "Hyderabad", ["https://reddit.com/r/1"]),
        mkFinding("location", "Bengaluru", ["https://reddit.com/r/2"]),
      ]),
    });
    const locs = res.clusters.filter((c) => c.signalType === "location");
    expect(locs.length).toBe(2);
  });
});

/* ── Independence counting ─────────────────────────────────────────────── */

describe("independence counting", () => {
  test("distinct permalinks are counted (not evidence entries)", () => {
    const f: Finding = {
      category: "location",
      claim: "Hyderabad",
      confidence: "high",
      rationale: "test",
      evidence: [
        { quote: "a", permalink: "https://reddit.com/r/x/1" },
        { quote: "b", permalink: "https://reddit.com/r/x/1" },
        { quote: "c", permalink: "https://reddit.com/r/x/2" },
      ],
      remediation: "test",
    };
    const res = run({ structured: mkStructured([f]) });
    const loc = res.clusters.find((c) => c.signalType === "location")!;
    expect(loc.sourceBreakdown.reddit_evidence).toBe(2);
  });

  test("empty-evidence finding has zero weight", () => {
    const res = run({
      structured: mkStructured([mkFinding("real_name", "Jane Smith", [])]),
    });
    expect(res.clusters).toEqual([]);
    expect(res.score).toBe(0);
  });

  test("web page URLs count; platform metadata is not another source", () => {
    const res = run({
      webSweep: mkWebSweep({
        identifiers: { emails: [], socialHandles: [mkHandle("x", "janedoe", "https://x.com/janedoe")] },
        identifierSources: {
          emails: {},
          handles: { "x:janedoe": ["https://page1.com", "https://page2.com"] },
          freemail: {},
        },
      }),
      directIdentifiers: { emails: [], socialHandles: [] },
    });
    const h = res.clusters.find((c) => c.signalType === "handle")!;
    expect(h.sourceBreakdown.web).toBe(2);
  });

  test("cross-domain sum matches the plan example", () => {
    const res = run({
      structured: mkStructured([mkFinding("location", "Hyderabad", ["https://reddit.com/r/1"])]),
      gitHub: mkGitHub([mkGitHubIdentity({ login: "jane", location: "Hyderabad" })]),
    });
    const loc = res.clusters.find((c) => c.signalType === "location")!;
    expect(loc.independentSources).toBe(2);
    expect(loc.domainCount).toBe(2);
  });
});

/* ── Contradiction detection ───────────────────────────────────────────── */

describe("contradiction detection", () => {
  test("two corroborated locations flag a contradiction", () => {
    const res = run({
      structured: mkStructured([
        mkFinding("location", "Hyderabad", ["https://reddit.com/r/1", "https://reddit.com/r/2"]),
        mkFinding("location", "Bengaluru", ["https://reddit.com/r/3", "https://reddit.com/r/4"]),
      ]),
    });
    expect(res.contradictions.some((c) => c.includes("Conflicting locations"))).toBe(true);
    const locs = res.clusters.filter((c) => c.signalType === "location");
    expect(locs.every((c) => (c.contradictions?.length ?? 0) > 0)).toBe(true);
  });

  test("nested location string (Hyderabad ⊂ Hyderabad, Telangana) merges, no contradiction", () => {
    const res = run({
      structured: mkStructured([
        mkFinding("location", "Hyderabad", ["https://reddit.com/r/1"]),
        mkFinding("location", "Hyderabad, Telangana", ["https://reddit.com/r/2"]),
      ]),
      gitHub: mkGitHub([mkGitHubIdentity({ login: "jane", location: "Hyderabad" })]),
    });
    const locs = res.clusters.filter((c) => c.signalType === "location");
    expect(locs.length).toBe(1);
    expect(res.contradictions).toEqual([]);
  });

  test("age vs GitHub account age flags inconsistency", () => {
    const res = run({
      structured: mkStructured([mkFinding("age_or_dob", "19", ["https://reddit.com/r/1"])]),
      gitHub: mkGitHub([mkGitHubIdentity({ login: "jane", accountCreated: "2011-01-01" })]),
    });
    // 19 - (2026 - 2011) = 4 < 8 → contradiction
    expect(
      res.contradictions.some((c) => c.includes("inconsistent with GitHub account created 2011")),
    ).toBe(true);
  });

  test("a posting-time fit on the other side of the world contradicts a location", () => {
    const res = run({
      structured: mkStructured([mkFinding("location", "Hyderabad", ["https://reddit.com/r/1"])]),
      timezone: {
        offsetMinutes: -300, label: "UTC-05:00", postCount: 50, confidence: "high",
        nightFraction: 0.05, plateauFromMinutes: -300, plateauToMinutes: -300,
        medianNightFraction: 0.2, localHourHistogram: Array(24).fill(2),
      },
    });
    expect(res.contradictions.some((c) => c.includes("Posting-time fit UTC-05:00 conflicts with location"))).toBe(true);
    // The fit is itself a cluster, but never a strong identity anchor.
    expect(res.clusters.some((c) => c.signalType === "timezone")).toBe(true);
  });

  test("a low-confidence fit never contradicts", () => {
    const res = run({
      structured: mkStructured([mkFinding("location", "Hyderabad", ["https://reddit.com/r/1"])]),
      timezone: {
        offsetMinutes: -300, label: "UTC-05:00", postCount: 12, confidence: "low",
        nightFraction: 0.05, plateauFromMinutes: -300, plateauToMinutes: -300,
        medianNightFraction: 0.2, localHourHistogram: Array(24).fill(2),
      },
    });
    expect(res.contradictions.some((c) => c.includes("Posting-time fit"))).toBe(false);
  });

  test("a model age far from the deterministic timeline contradicts", () => {
    const res = run({
      structured: mkStructured([mkFinding("age_or_dob", "31", ["https://reddit.com/r/1"])]),
      ageEstimates: [{
        birthYearRange: [2004, 2005], ageRange: [20, 21], chain: "test",
        basis: "2nd year", program: "bachelor", confidence: "medium",
      }],
    });
    expect(res.contradictions.some((c) => c.includes("conflicts with the deterministic timeline"))).toBe(true);
  });

  test("an age inside the deterministic range does not contradict", () => {
    const res = run({
      structured: mkStructured([mkFinding("age_or_dob", "21", ["https://reddit.com/r/1"])]),
      ageEstimates: [{
        birthYearRange: [2004, 2005], ageRange: [20, 21], chain: "test",
        basis: "2nd year", program: "bachelor", confidence: "medium",
      }],
    });
    expect(res.contradictions.some((c) => c.includes("deterministic timeline"))).toBe(false);
  });

  test("two disjoint real names both sourced flag a contradiction", () => {
    const res = run({
      structured: mkStructured([
        mkFinding("real_name", "John Doe", ["https://reddit.com/r/1"]),
        mkFinding("real_name", "Jane Smith", ["https://reddit.com/r/2"]),
      ]),
    });
    expect(res.contradictions.some((c) => c.includes("Conflicting real names"))).toBe(true);
  });
});

/* ── overallRisk + score ───────────────────────────────────────────────── */

describe("overallRisk + score", () => {
  const mkRisk = (confidences: Array<{ type: string; confidence: "low" | "medium" | "high"; independentSources?: number }>) => {
    const clusters: Array<CorroborationCluster & { signalType: any }> = confidences.map((c, i) => ({
      key: `${c.type}:${i}`,
      signalType: c.type as any,
      value: c.type + i,
      confidence: c.confidence,
      independentSources: c.independentSources ?? 1,
      domainCount: c.independentSources && c.independentSources >= 2 ? 2 : 1,
      sourceBreakdown: { reddit_evidence: 1, web: 0, github: 0, direct: 0 },
      corroborating: (c.independentSources ?? 1) >= 2,
      evidence: [],
    }));
    return clusters;
  };

  test("strong identity high → high", () => {
    const clusters = mkRisk([
      { type: "real_name", confidence: "high", independentSources: 2 },
      { type: "location", confidence: "low", independentSources: 1 },
    ]);
    expect(mapOverallRisk(clusters, [])).toBe("high");
  });

  test("two high non-identity clusters → high", () => {
    const clusters = mkRisk([
      { type: "location", confidence: "high", independentSources: 2 },
      { type: "employer", confidence: "high", independentSources: 2 },
    ]);
    expect(mapOverallRisk(clusters, [])).toBe("high");
  });

  test("one high cluster only → medium", () => {
    const clusters = mkRisk([{ type: "location", confidence: "high", independentSources: 2 }]);
    expect(mapOverallRisk(clusters, [])).toBe("medium");
  });

  test("two medium clusters → medium", () => {
    const clusters = mkRisk([
      { type: "location", confidence: "medium" },
      { type: "employer", confidence: "medium" },
    ]);
    expect(mapOverallRisk(clusters, [])).toBe("medium");
  });

  test("only low clusters → low", () => {
    const clusters = mkRisk([{ type: "location", confidence: "low" }]);
    expect(mapOverallRisk(clusters, [])).toBe("low");
  });

  test("high result with a location contradiction downgrades to medium", () => {
    const clusters = mkRisk([
      { type: "location", confidence: "high", independentSources: 2 },
      { type: "employer", confidence: "high", independentSources: 2 },
    ]);
    clusters[0].contradictions = ["bengaluru"];
    expect(mapOverallRisk(clusters, ["Conflicting locations: bengaluru vs hyderabad"])).toBe("medium");
  });

  test("maxRisk ordering", () => {
    expect(maxRisk("low", "high")).toBe("high");
    expect(maxRisk("medium", "low")).toBe("medium");
    expect(maxRisk("high", "high")).toBe("high");
  });

  test("score monotonic sanity + bounds", () => {
    const lone = run({ structured: mkStructured([mkFinding("location", "Hyderabad", [])]) });
    expect(lone.score).toBe(0); // a claim without provenance has zero weight

    const rich = run({
      structured: mkStructured([
        mkFinding("real_name", "John Doe", ["https://reddit.com/r/1", "https://reddit.com/r/2"]),
        mkFinding("location", "Hyderabad", ["https://reddit.com/r/3", "https://reddit.com/r/4"]),
      ]),
      gitHub: mkGitHub([
        mkGitHubIdentity({ login: "johndoe", name: "John Doe", location: "Hyderabad, India" }),
      ]),
    });
    expect(rich.score).toBeGreaterThan(lone.score);
    expect(rich.score).toBeLessThanOrEqual(100);
  });
});

/* ── Edge cases / failure mode ─────────────────────────────────────────── */

describe("edge cases", () => {
  test("empty input returns an empty-but-valid result", () => {
    const res = run({});
    expect(res.clusters).toEqual([]);
    expect(res.score).toBe(0);
    expect(res.overallRisk).toBe("low");
    expect(res.contradictions).toEqual([]);
    expect(res.verdict.exposureSeverity).toBe("low");
    expect(res.verdict.attributionConfidence).toBe("low");
    expect(renderCorroborationBlock(res)).toBe("");
  });

  test("standard path (no web/github) still works", () => {
    const res = run({
      structured: mkStructured([mkFinding("real_name", "Jane Smith", ["https://reddit.com/r/1"])]),
    });
    expect(res.clusters.length).toBe(1);
    expect(res.clusters[0].sourceBreakdown.reddit_evidence).toBe(1);
    expect(res.overallRisk).toBe("low");
  });

  test("no permalinks anywhere → unsupported claims cannot score", () => {
    const res = run({
      structured: mkStructured([
        mkFinding("real_name", "Jane Smith", []),
        mkFinding("location", "Pune", []),
      ]),
    });
    expect(res.clusters).toEqual([]);
    expect(res.score).toBe(0);
  });

  test("malformed inputs never throw (total-function contract)", () => {
    const malformed = run({
      structured: {
        overallRisk: "low",
        summary: "",
        findings: [{ category: "other", nonsense: true }, mkFinding("real_name", "Jane Smith", ["https://reddit.com/r/1"])],
      } as any,
      directIdentifiers: { emails: [null], socialHandles: [{ platform: null, handle: null, url: null }] } as any,
      gitHub: {
        queried: [],
        identities: [{ login: "x", commitAuthors: [{ name: null }] }],
        rateLimited: false,
      } as any,
      webSweep: { username: "x", identifiers: { emails: [null], socialHandles: [null] } } as any,
    });
    // Malformed items are skipped per item, not by the catch-all empty result:
    // the one well-formed finding still clusters.
    expect(malformed.clusters.map((c) => c.value)).toEqual(["Jane Smith"]);
    expect(malformed.score).toBeGreaterThan(0);
  });

  test("freemail vs custom domain affects the custom-email bonus", () => {
    const base = {
      directIdentifiers: { emails: ["jane@gmail.com"], socialHandles: [] },
      webSweep: mkWebSweep({
        identifiers: { emails: ["jane@gmail.com"], socialHandles: [] },
        identifierSources: {
          emails: { "jane@gmail.com": ["https://page1.com"] },
          handles: {},
          freemail: { "jane@gmail.com": true },
        },
      }),
    };
    const custom = {
      directIdentifiers: { emails: ["jane@acme.dev"], socialHandles: [] },
      webSweep: mkWebSweep({
        identifiers: { emails: ["jane@acme.dev"], socialHandles: [] },
        identifierSources: {
          emails: { "jane@acme.dev": ["https://page1.com"] },
          handles: {},
          freemail: { "jane@acme.dev": false },
        },
      }),
    };
    const gmail = run(base).clusters.find((c) => c.signalType === "email")!;
    const acme = run(custom).clusters.find((c) => c.signalType === "email")!;
    expect(gmail.freemail).toBe(true);
    expect(acme.freemail).toBe(false);
    // Both are 1 direct + 1 web = 2 sources, 2 domains → medium base.
    // Custom domain adds +1 → still medium (2+2+1=5). Assert they don't differ
    // by a full band here; the flag itself is the contract.
    expect(gmail.confidence).toBe("medium");
    expect(acme.confidence).toBe("medium");
  });
});

/* ── Double-count regression (Milestone 1 correctness firebreak) ────────── */

describe("no double counting across domains", () => {
  test("a GitHub-only handle counts ONCE (github domain only)", () => {
    // The pre-fix pipeline merged GitHub handles into the `direct` set before
    // corroboration, so this handle was counted under BOTH `direct` and
    // `github` (one observation, two domains). With corpus-only `direct`, it
    // must count exactly once under github.
    const res = run({
      gitHub: mkGitHub([mkGitHubIdentity({ login: "janedoe" })]),
      directIdentifiers: { emails: [], socialHandles: [] },
      webSweep: mkWebSweep(),
    });
    const h = res.clusters.find((c) => c.signalType === "handle")!;
    expect(h.sourceBreakdown.github).toBe(1);
    expect(h.sourceBreakdown.direct).toBe(0);
    expect(h.sourceBreakdown.web).toBe(0);
    expect(h.domainCount).toBe(1);
  });

  test("a web-sweep-only handle counts ONCE (web domain only)", () => {
    const res = run({
      webSweep: mkWebSweep({
        identifiers: { emails: [], socialHandles: [mkHandle("instagram", "janedoe", "https://instagram.com/janedoe")] },
        identifierSources: {
          emails: {},
          handles: { "instagram:janedoe": ["https://page.com"] },
          freemail: {},
        },
      }),
      directIdentifiers: { emails: [], socialHandles: [] },
    });
    const h = res.clusters.find((c) => c.signalType === "handle")!;
    expect(h.sourceBreakdown.web).toBe(1); // one originating page
    expect(h.sourceBreakdown.direct).toBe(0);
    expect(h.sourceBreakdown.github).toBe(0);
  });

  test("a genuinely cross-domain handle (corpus + web + github) DOES count 3 domains", () => {
    // Three truly independent observations → this is real corroboration, not
    // a double count. The fix must not suppress genuine cross-domain agreement.
    const res = run({
      directIdentifiers: { emails: [], socialHandles: [mkHandle("reddit", "janedoe", "https://reddit.com/u/janedoe")] },
      webSweep: mkWebSweep({
        identifiers: { emails: [], socialHandles: [mkHandle("x", "janedoe", "https://x.com/janedoe")] },
        identifierSources: { emails: {}, handles: { "x:janedoe": ["https://example.org/jane"] }, freemail: {} },
      }),
      gitHub: mkGitHub([mkGitHubIdentity({ login: "janedoe" })]),
    });
    const h = res.clusters.find((c) => c.signalType === "handle")!;
    expect(h.sourceBreakdown.direct).toBe(1);
    expect(h.sourceBreakdown.web).toBe(1);
    expect(h.sourceBreakdown.github).toBe(1);
    expect(h.domainCount).toBe(3);
  });
});

/* ── Twitter domain (5th corroboration source) ─────────────────────────── */

function mkTwitterProfile(partial: Partial<TwitterUserProfile> & { screenName: string }): TwitterUserProfile {
  return {
    id: `tw-${partial.screenName}`,
    name: partial.screenName,
    bio: "",
    location: "",
    url: "",
    followers: 0,
    following: 0,
    tweets: 0,
    likes: 0,
    verified: false,
    profileImageUrl: "",
    createdAt: "",
    ...partial,
  };
}

function mkTwitterResult(
  profiles: Array<TwitterUserProfile & { altCandidates?: TwitterPassResult["results"][number]["altCandidates"] }>,
): TwitterPassResult {
  return {
    seeds: profiles.map((p) => p.screenName),
    results: profiles.map((p) => ({
      seed: p.screenName,
      profile: p,
      followingScanned: 0,
      altCandidates: p.altCandidates ?? [],
    })),
    identifiers: { emails: [], socialHandles: [] },
    identifierSources: { emails: {}, handles: {} },
    rateLimited: false,
  };
}

describe("calibrateConfidence with the twitter domain", () => {
  test("twitter sources count toward sources and domains", () => {
    const r = calibrateConfidence({ reddit_evidence: 1, web: 0, github: 0, direct: 0, twitter: 2 });
    expect(r.independentSources).toBe(3);
    expect(r.domainCount).toBe(2);
  });

  test("twitter-only observations are weak (single domain)", () => {
    const r = calibrateConfidence({ reddit_evidence: 0, web: 0, github: 0, direct: 0, twitter: 3 });
    expect(r.confidence).toBe("medium"); // 3 sources, one domain — repetition ≠ independence
    expect(r.domainCount).toBe(1);
  });

  test("twitter caps at 3 (no saturation)", () => {
    const r = calibrateConfidence({ reddit_evidence: 0, web: 0, github: 0, direct: 0, twitter: 99 });
    expect(r.independentSources).toBe(3);
  });

  test("omitting twitter preserves the four-domain behavior", () => {
    const r = calibrateConfidence({ reddit_evidence: 1, web: 0, github: 1, direct: 0 });
    expect(r.independentSources).toBe(2);
    expect(r.domainCount).toBe(2);
  });
});

describe("twitter domain clustering", () => {
  test("a twitter profile handle forms a cluster counted under twitter", () => {
    const res = run({
      twitter: mkTwitterResult([mkTwitterProfile({ screenName: "fixturenew" })]),
    });
    const h = res.clusters.find((c) => c.signalType === "handle" && c.value === "fixturenew");
    expect(h).toBeDefined();
    expect(h?.sourceBreakdown.twitter).toBe(1);
    expect(h?.sourceBreakdown.direct).toBe(0);
  });

  test("twitter + corpus observations of the same handle merge into ONE cross-domain cluster", () => {
    const res = run({
      directIdentifiers: { emails: [], socialHandles: [mkHandle("x", "janedoe", "https://x.com/janedoe")] },
      twitter: mkTwitterResult([mkTwitterProfile({ screenName: "jane_doe" })]),
    });
    const handles = res.clusters.filter((c) => c.signalType === "handle");
    expect(handles.length).toBe(1);
    expect(handles[0].domainCount).toBe(2);
    expect(handles[0].sourceBreakdown.direct).toBe(1);
    expect(handles[0].sourceBreakdown.twitter).toBe(1);
  });

  test("a real-name display name on a twitter profile becomes a real_name cluster", () => {
    const res = run({
      twitter: mkTwitterResult([mkTwitterProfile({ screenName: "0xfixture", name: "Rohan Sharma" })]),
    });
    const name = res.clusters.find((c) => c.signalType === "real_name" && c.value === "Rohan Sharma");
    expect(name).toBeDefined();
    expect(name?.sourceBreakdown.twitter).toBe(1);
  });

  test("alt-account candidate handles count under twitter", () => {
    const res = run({
      twitter: mkTwitterResult([
        {
          ...mkTwitterProfile({ screenName: "fixturenew" }),
          altCandidates: [{ profile: mkTwitterProfile({ screenName: "0xfixture", name: "Rohan Sharma" }), score: 4, reasons: ["scheme match"] }],
        },
      ]),
    });
    const alt = res.clusters.find((c) => c.signalType === "handle" && c.value === "0xfixture");
    expect(alt).toBeDefined();
    expect(alt?.sourceBreakdown.twitter).toBe(1);
  });

  test("reclaimed audited handle surfaces a WARNING (not a contradiction) and does not downgrade risk", () => {
    const res = run({
      twitter: mkTwitterResult([
        mkTwitterProfile({ screenName: "target_user", createdAtISO: "2025-06-01T00:00:00Z" }),
      ]),
      webSweep: mkWebSweep({
        redditProfile: { createdUtc: 1577836800, karma: 1, text: "" }, // 2020-01-01
      }),
    });
    expect(res.warnings.some((w) => w.includes("reclaimed"))).toBe(true);
    expect(res.contradictions).toEqual([]);
  });

  test("reclaimed NON-audited handle gets a cluster-level warning", () => {
    const res = run({
      twitter: mkTwitterResult([
        mkTwitterProfile({ screenName: "squattedhandle", createdAtISO: "2025-06-01T00:00:00Z" }),
      ]),
      webSweep: mkWebSweep({
        redditProfile: { createdUtc: 1577836800, karma: 1, text: "" },
      }),
    });
    const h = res.clusters.find((c) => c.signalType === "handle" && c.value === "squattedhandle");
    expect(h?.warnings?.some((w) => w.includes("reclaimed"))).toBe(true);
  });

  test("handle created before the subject timeline is NOT flagged", () => {
    const res = run({
      twitter: mkTwitterResult([
        mkTwitterProfile({ screenName: "target_user", createdAtISO: "2018-06-01T00:00:00Z" }),
      ]),
      webSweep: mkWebSweep({
        redditProfile: { createdUtc: 1577836800, karma: 1, text: "" },
      }),
    });
    expect(res.warnings).toEqual([]);
  });

  test("renderer shows the twitter breakdown and warnings section", () => {
    const res = run({
      twitter: mkTwitterResult([
        mkTwitterProfile({ screenName: "target_user", createdAtISO: "2025-06-01T00:00:00Z" }),
      ]),
      webSweep: mkWebSweep({
        redditProfile: { createdUtc: 1577836800, karma: 1, text: "" },
      }),
    });
    const block = renderCorroborationBlock(res);
    expect(block).toContain("**⚠️ Warnings**");
    expect(block).toContain("reclaimed");
  });
});

/* ── Reddit-side handle disclosures (corpusTexts + disclosure findings) ─── */

describe("reddit-side handle disclosures", () => {
  const mkSweep = () =>
    mkWebSweep({
      identifiers: { emails: [], socialHandles: [mkHandle("discord", "nightowl42", "https://discord.com/users/1")] },
      identifierSources: { emails: {}, handles: { "discord:nightowl42": ["https://example.org/about"] }, freemail: {} },
    });

  test("corpus mention of a web-sweep handle adds a reddit source, corroborates, raises confidence", () => {
    const withCorpus = run({
      webSweep: mkSweep(),
      corpusTexts: [{ text: "my discord is nightowl42 btw", permalink: "/r/chat/abc" }],
    });
    const h = withCorpus.clusters.find((c) => c.signalType === "handle")!;
    expect(h).toBeDefined();
    expect(h.sourceBreakdown.reddit_evidence).toBe(1);
    expect(h.corroborating).toBe(true);
    // Same input without corpusTexts: web-only, single domain, low.
    const without = run({ webSweep: mkSweep() });
    const h2 = without.clusters.find((c) => c.signalType === "handle")!;
    expect(h2.sourceBreakdown.reddit_evidence).toBe(0);
    expect(h2.corroborating).toBe(false);
    expect(h.confidence).toBe("medium");
    expect(h2.confidence).toBe("low");
  });

  test("disclosure guard: URL fragments and plain prose do NOT count; @ and u/ do", () => {
    const fragments = run({
      webSweep: mkSweep(),
      corpusTexts: [
        { text: "see https://example.com/nightowl42/i/x for the thread", permalink: "/r/1" },
        { text: "vote here ?id=nightowl42 please", permalink: "/r/2" },
        { text: "the user [nightowl42] posted that", permalink: "/r/6" },
      ],
    });
    const hf = fragments.clusters.find((c) => c.signalType === "handle")!;
    expect(hf.sourceBreakdown.reddit_evidence).toBe(0);

    const visible = run({
      webSweep: mkSweep(),
      corpusTexts: [
        { text: "ping @nightowl42 anytime", permalink: "/r/3" },
        { text: "the user u/nightowl42 posted that", permalink: "/r/4" },
      ],
    });
    const hv = visible.clusters.find((c) => c.signalType === "handle")!;
    expect(hv.sourceBreakdown.reddit_evidence).toBe(2);
  });

  test("cross_platform_handle finding whose claim names the handle counts its permalink once", () => {
    const res = run({
      webSweep: mkSweep(),
      structured: mkStructured([
        mkFinding("cross_platform_handle", "also goes by nightowl42 elsewhere", ["/r/disclosure/1"]),
      ]),
    });
    const h = res.clusters.find((c) => c.signalType === "handle")!;
    expect(h.sourceBreakdown.reddit_evidence).toBe(1);
    expect(h.evidence).toContain("https://reddit.com/r/disclosure/1");
  });

  test("a finding's permalink counts only when that corpus item names the handle", () => {
    const res = run({
      webSweep: mkSweep(),
      corpusTexts: [{ text: "just a post about owls at night", permalink: "/r/disclosure/1" }],
      structured: mkStructured([
        mkFinding("cross_platform_handle", "also goes by nightowl42 elsewhere", ["/r/disclosure/1"]),
      ]),
    });
    const h = res.clusters.find((c) => c.signalType === "handle")!;
    expect(h.sourceBreakdown.reddit_evidence).toBe(0);

    const named = run({
      webSweep: mkSweep(),
      corpusTexts: [{ text: "ping nightowl42 for the notes", permalink: "/r/disclosure/1" }],
      structured: mkStructured([
        mkFinding("cross_platform_handle", "also goes by nightowl42 elsewhere", ["/r/disclosure/1"]),
      ]),
    });
    expect(named.clusters.find((c) => c.signalType === "handle")!.sourceBreakdown.reddit_evidence).toBe(1);
  });

  test("audited username mentioned in the corpus never creates or feeds a cluster", () => {
    const res = run({
      webSweep: mkSweep(),
      corpusTexts: [{ text: "target_user here, my discord is nightowl42", permalink: "/r/5" }],
    });
    const handles = res.clusters.filter((c) => c.signalType === "handle");
    expect(handles.every((h) => h.value !== "target_user")).toBe(true);
    const h = handles.find((c) => c.value === "nightowl42")!;
    expect(h.sourceBreakdown.reddit_evidence).toBe(1);
  });
});

/* ── Platform vs domain de-conflation in the tier bonus ────────────────── */

describe("platform de-conflation", () => {
  test("one GitHub profile through two pipes → one document and no cluster tier", () => {
    const res = run({
      webSweep: mkWebSweep({
        identifiers: { emails: [], socialHandles: [mkHandle("github", "janedoe", "https://github.com/janedoe")] },
        identifierSources: {
          emails: {},
          handles: { "github:janedoe": ["https://github.com/janedoe"] },
          freemail: {},
        },
      }),
      gitHub: mkGitHub([mkGitHubIdentity({ login: "janedoe" })]),
    });
    const h = res.clusters.find((c) => c.signalType === "handle")!;
    expect(h.tier).toBeUndefined(); // single platform → no tier, no +1 bonus
    expect(h.domainCount).toBe(1);
    expect(h.independentSources).toBe(1);
    expect(h.sourceBreakdown.web).toBe(0);
    expect(h.sourceBreakdown.github).toBe(1);
  });

  test("genuinely different platforms (web x + GitHub login) still earn the cluster tier", () => {
    const res = run({
      webSweep: mkWebSweep({
        identifiers: { emails: [], socialHandles: [mkHandle("x", "janedoe", "https://x.com/janedoe")] },
      }),
      gitHub: mkGitHub([mkGitHubIdentity({ login: "janedoe" })]),
    });
    const h = res.clusters.find((c) => c.signalType === "handle")!;
    expect(h.tier).toBe("cross-platform cluster");
  });
});

/* ── Nested location containment ───────────────────────────────────────── */

describe("nested location containment", () => {
  test("github 'Uppal, Hyderabad, India' + reddit 'Hyderabad' merge into ONE cluster, no contradiction", () => {
    const res = run({
      structured: mkStructured([mkFinding("location", "Hyderabad", ["https://reddit.com/r/hyd/1"])]),
      gitHub: mkGitHub([mkGitHubIdentity({ login: "jane", location: "Uppal, Hyderabad, India" })]),
    });
    const locs = res.clusters.filter((c) => c.signalType === "location");
    expect(locs.length).toBe(1);
    // The most specific surface form wins the display value.
    expect(locs[0].value).toBe("Uppal, Hyderabad, India");
    expect(locs[0].domainCount).toBe(2);
    expect(locs[0].corroborating).toBe(true);
    expect(res.contradictions).toEqual([]);
    // No risk downgrade: one corroborated location cluster → medium.
    expect(res.overallRisk).toBe("medium");
  });

  test("'Chennai, India' vs 'Hyderabad, India' still contradict (shared country must not merge)", () => {
    const res = run({
      structured: mkStructured([mkFinding("location", "Hyderabad, India", ["https://reddit.com/r/1"])]),
      gitHub: mkGitHub([mkGitHubIdentity({ login: "jane", location: "Chennai, India" })]),
    });
    const locs = res.clusters.filter((c) => c.signalType === "location");
    expect(locs.length).toBe(2);
    expect(res.contradictions.some((c) => c.includes("Conflicting locations"))).toBe(true);
    expect(res.overallRisk).toBe("low"); // two mediums would be medium; the contradiction downgrades
  });
});

describe("person-aware corroboration", () => {
  test("a same-username account the graph split off never scores for the subject", () => {
    const input: CorroborationInput = {
      username: "target_user",
      corpusTexts: [{ text: "I live in Manchester and love it", permalink: "https://reddit.com/r/test/comments/m/x" }],
      gitHub: mkGitHub([mkGitHubIdentity({ login: "target_user", name: "Ken Sato", email: "ken@corp.example", location: "Tokyo, Japan" })]),
    };
    const result = run({ ...input, identityGraph: buildIdentityGraph(input) });
    const leaked = result.clusters.filter((c) => c.isSubject !== false && ["email", "real_name", "location"].includes(c.signalType));
    expect(leaked).toEqual([]);
    expect(result.score).toBe(0);
  });

  function withGraph(input: CorroborationInput): CorroborationResult {
    return run({
      ...input,
      identityGraph: buildIdentityGraph({ ...input, corpusIdentifiers: input.directIdentifiers }),
    });
  }

  test("namesake observations cannot merge with or change the subject's verdict", () => {
    const subject = mkGitHubIdentity({
      login: "target_user", name: "Avery Lane", location: "Hyderabad", company: "Acme",
    });
    const input: CorroborationInput = {
      username: "target_user",
      structured: mkStructured([
        mkFinding("real_name", "Avery Lane", ["https://reddit.com/r/test/name"]),
        mkFinding("location", "Hyderabad", ["https://reddit.com/r/test/location"]),
        mkFinding("employer_or_school", "Acme", ["https://reddit.com/r/test/company"]),
        mkFinding("age_or_dob", "19", ["https://reddit.com/r/test/age"]),
      ]),
      gitHub: mkGitHub([subject]),
    };
    const baseline = withGraph(input);
    const result = withGraph({
      ...input,
      gitHub: mkGitHub([
        subject,
        mkGitHubIdentity({
          login: "elsewhere", name: "Avery Stone", location: "Hyderabad, India", company: "Acme Inc",
          accountCreated: "2000-01-01T00:00:00Z",
          commitAuthors: [{ name: "Avery Stone", email: "", repo: "target_user/shared", attributedLogin: "elsewhere" }],
        }),
      ]),
      twitter: mkTwitterResult([mkTwitterProfile({ screenName: "elsewhere", name: "Avery Stone", location: "Chennai" })]),
    });
    expect(result.clusters.filter((c) => c.isSubject !== false)).toEqual(baseline.clusters);
    expect(result.clusters.filter((c) => c.isSubject === false).length).toBeGreaterThan(0);
    expect(result.score).toBe(baseline.score);
    expect(result.verdict).toEqual(baseline.verdict);
    expect(result.overallRisk).toBe(baseline.overallRisk);
    expect(result.contradictions).toEqual([]);
    const separateLocations = result.clusters.filter((c) => c.signalType === "location" && c.isSubject === false);
    expect(separateLocations.every((c) => c.contradictions?.length === 1)).toBe(true);
    expect(renderCorroborationBlock(result)).toContain("separate person");
  });

  test("conflicting locations within the subject still downgrade risk", () => {
    const result = withGraph({
      username: "target_user",
      structured: mkStructured([mkFinding("location", "Hyderabad", ["https://reddit.com/r/test/location"])]),
      gitHub: mkGitHub([mkGitHubIdentity({ login: "target_user", location: "Chennai" })]),
    });
    expect(result.clusters.filter((c) => c.signalType === "location").length).toBe(2);
    expect(result.contradictions).toEqual(["Conflicting locations: Chennai vs Hyderabad"]);
    expect(result.overallRisk).toBe("low");
  });

  test("corpus disclosure joins a previously separate handle before scoring", () => {
    const input: CorroborationInput = {
      username: "target_user",
      gitHub: mkGitHub([mkGitHubIdentity({ login: "newidentity", name: "Morgan Vale" })]),
    };
    expect(withGraph(input).score).toBe(0);
    const result = withGraph({ ...input, corpusTexts: [{ text: "My handle is @newidentity", permalink: "https://reddit.com/r/test/alt" }] });
    const handle = result.clusters.find((c) => c.signalType === "handle");
    expect(handle?.isSubject).toBe(true);
    expect(handle?.sourceBreakdown).toMatchObject({ reddit_evidence: 1, github: 1 });
    expect(result.score).toBeGreaterThan(0);
    expect(result.verdict.attributionConfidence).toBe("high");
  });

  test("each provenance URL contributes only to its page owner's person", () => {
    const result = withGraph({
      username: "target_user",
      corpusTexts: [{ text: "My handle is newidentity", permalink: "https://reddit.com/r/test/handle" }],
      gitHub: mkGitHub([
        mkGitHubIdentity({ login: "target_user" }),
        mkGitHubIdentity({ login: "elsewhere", name: "Avery Stone", blog: "https://other.example" }),
      ]),
      structured: mkStructured([mkFinding("location", "Chennai", ["https://github.com/elsewhere"])]),
      webSweep: mkWebSweep({
        identifiers: { emails: ["target_user@gmail.com"], socialHandles: [mkHandle("x", "newidentity", "https://x.com/newidentity")] },
        identifierSources: {
          handles: { "x:newidentity": ["https://x.com/newidentity", "https://github.com/elsewhere"] },
          emails: { "target_user@gmail.com": ["https://github.com/target_user", "https://other.example/about"] },
          freemail: { "target_user@gmail.com": true },
        },
      }),
    });
    const subjectHandle = result.clusters.find((c) => c.signalType === "handle" && c.value === "newidentity" && c.isSubject);
    expect(subjectHandle?.sourceBreakdown.twitter).toBe(1);
    const otherHandle = result.clusters.find((c) => c.signalType === "handle" && c.value === "newidentity" && c.isSubject === false);
    expect(otherHandle?.sourceBreakdown.github).toBe(1);
    const subjectEmail = result.clusters.find((c) => c.signalType === "email" && c.isSubject);
    expect(subjectEmail?.sourceBreakdown.github).toBe(1);
    expect(result.clusters.find((c) => c.signalType === "email" && c.isSubject === false)?.sourceBreakdown.web).toBe(1);
    expect(result.clusters.find((c) => c.signalType === "location")?.isSubject).toBe(false);
    expect(result.contradictions).toEqual([]);
  });

  test("email local-part bonus crosses a confidence boundary without inventing sources", () => {
    const makeInput = (email: string): CorroborationInput => ({
      username: "target_user",
      directIdentifiers: { emails: [email], socialHandles: [] },
      webSweep: mkWebSweep({
        identifiers: { emails: [email], socialHandles: [] },
        identifierSources: { emails: { [email.toLowerCase()]: ["https://example.org/about", "https://example.net/contact"] }, handles: {}, freemail: { [email.toLowerCase()]: true } },
      }),
    });
    const matched = withGraph(makeInput("Target.User@gmail.com")).clusters.find((c) => c.signalType === "email")!;
    const unmatched = withGraph(makeInput("unrelated@gmail.com")).clusters.find((c) => c.signalType === "email")!;
    expect(matched.confidence).toBe("high");
    expect(unmatched.confidence).toBe("medium");
    expect(matched.emailLocalPartMatch).toBe(true);
    expect(unmatched.emailLocalPartMatch).toBeUndefined();
    expect(matched.sourceBreakdown).toEqual(unmatched.sourceBreakdown);
    expect(matched.independentSources).toBe(3);
    expect(matched.domainCount).toBe(2);
    const single = withGraph({ username: "target_user", directIdentifiers: { emails: ["target_user@gmail.com"], socialHandles: [] } });
    expect(single.clusters[0].confidence).toBe("low");
    expect(single.clusters[0].independentSources).toBe(1);
    const input = makeInput("Target.User@gmail.com");
    const graph = buildIdentityGraph({ ...input, corpusIdentifiers: input.directIdentifiers });
    const withoutEdge = run({ ...input, identityGraph: { ...graph, edges: [] } });
    expect(withoutEdge.clusters.find((c) => c.signalType === "email")?.confidence).toBe("medium");
    // Web-only email: a corpus email would be a subject disclosure, not a namesake.
    const namesake = withGraph({
      ...makeInput("elsewhere@gmail.com"),
      directIdentifiers: { emails: [], socialHandles: [] },
      gitHub: mkGitHub([mkGitHubIdentity({ login: "elsewhere", name: "Avery Stone" })]),
    });
    const namesakeEmail = namesake.clusters.find((c) => c.signalType === "email")!;
    expect(namesakeEmail.isSubject).toBe(false);
    expect(namesakeEmail.confidence).toBe("low"); // two web sources; +1 would make it medium
    expect(namesakeEmail.emailLocalPartMatch).toBeUndefined();
    expect(namesake.score).toBe(0);
    expect(renderCorroborationBlock(withGraph(makeInput("Target.User@gmail.com")))).toContain("local-part match");
  });
});

describe("identity-graph exposure floor", () => {
  const url = "https://github.com/newidentity";
  const sweep = (bridged: boolean) => mkWebSweep({
    identifiers: { emails: [], socialHandles: [mkHandle("github", "newidentity", url)] },
    identifierSources: { handles: { "github:newidentity": [url] }, emails: {}, freemail: {} },
    bridgeEvidence: bridged ? { newidentity: [{ url, snippet: "formerly target_user", target: "target_user" }] } : {},
  });
  const profile = (extra: Partial<GitHubIdentity> = {}) =>
    mkGitHub([mkGitHubIdentity({ login: "newidentity", name: "Morgan Vale", email: "morgan@vale.dev", location: "Pune", ...extra })]);
  const scored = (input: CorroborationInput) => run({ ...input, identityGraph: buildIdentityGraph(input) });

  test("a bridge to one profile with name + email floors risk at high without adding sources", () => {
    const input = { username: "target_user", webSweep: sweep(true), gitHub: profile() };
    const result = scored(input);
    expect(result.clusters.every((c) => c.confidence === "low" && c.independentSources === 1)).toBe(true);
    expect(result.overallRisk).toBe("high");
    expect(result.verdict.exposureSeverity).toBe("high");
    expect(run(input).overallRisk).toBe("low"); // no graph, no floor
  });

  test("name without email floors at medium; no strong link means no floor", () => {
    expect(scored({ username: "target_user", webSweep: sweep(true), gitHub: profile({ email: undefined }) }).overallRisk).toBe("medium");
    // Same profile, nothing tying it to the audited handle: a namesake stays low.
    const namesake = scored({ username: "target_user", webSweep: sweep(false), gitHub: profile() });
    expect(namesake.clusters.every((c) => c.isSubject === false)).toBe(true);
    expect(namesake.overallRisk).toBe("low");
  });

  test("a handle-echo name is not a real name and cannot trigger the high floor", () => {
    // Single-token handle echoes. (A two-token "New Identity" counts: GitHub's
    // name field is a separate declaration even when the login derives from it.)
    for (const name of ["newidentity", "new_identity", "NewIdentity"]) {
      const result = scored({
        username: "target_user", webSweep: sweep(true),
        gitHub: profile({ name, commitAuthors: [{ name: "NewIdentity", email: "", repo: "newidentity/x", attributedLogin: "newidentity" }] }),
      });
      expect(result.clusters.some((c) => c.signalType === "real_name")).toBe(false);
      expect(result.overallRisk).not.toBe("high");
    }
    // A real name from the same profile still clusters and floors at high.
    expect(scored({ username: "target_user", webSweep: sweep(true), gitHub: profile({ name: "Alice Chen" }) }).overallRisk).toBe("high");
  });

  test("with a graph, a cluster no person owns does not speak for the subject", () => {
    const input = { username: "target_user", webSweep: sweep(false) };
    const unowned = scored(input);
    expect(unowned.clusters.map((c) => c.isSubject)).toEqual([undefined]);
    expect(unowned.score).toBe(0);
    expect(run(input).score).toBeGreaterThan(0); // no graph: unowned clusters still count
  });

  test("a residence statement in the subject's posts corroborates the profile location", () => {
    const corpusTexts = [
      { text: "I live in Pune, rent is fine", permalink: "https://reddit.com/r/pune/comments/a1/x/" },
      { text: "I visited Pune once", permalink: "https://reddit.com/r/travel/comments/a2/x/" },
    ];
    const result = scored({ username: "target_user", webSweep: sweep(true), gitHub: profile(), corpusTexts });
    const pune = result.clusters.find((c) => c.signalType === "location")!;
    expect(pune.sourceBreakdown.reddit_evidence).toBe(1);
    expect(pune.independentSources).toBe(2);
  });

  test.each([
    "Can I live in Pune on 30k a month?",
    "If I moved to Pune, how much would rent cost?",
    "If I moved to Pune, I would need a new job.",
  ])("a hypothetical residence adds no evidence: %s", (text) => {
    const result = scored({
      username: "target_user", webSweep: sweep(true), gitHub: profile(),
      corpusTexts: [{ text, permalink: "https://reddit.com/r/pune/comments/a1/x/" }],
    });
    const pune = result.clusters.find((c) => c.signalType === "location")!;
    expect(pune.sourceBreakdown.reddit_evidence).toBe(0);
    expect(pune.independentSources).toBe(1);
    expect(pune.confidence).toBe("low");
  });

  test("contradictions still downgrade the floored risk one step", () => {
    const result = scored({
      username: "target_user", webSweep: sweep(true), gitHub: profile(),
      structured: mkStructured([mkFinding("location", "Chennai", ["https://reddit.com/r/test/loc"])]),
    });
    expect(result.contradictions).toEqual(["Conflicting locations: Chennai vs Pune"]);
    expect(result.overallRisk).toBe("medium");
    expect(mapOverallRisk([], [], "high")).toBe("high");
  });
});

describe("document-level deduplication and account labels", () => {
  const url = "https://github.com/janedoe";
  const github = mkGitHub([mkGitHubIdentity({ login: "janedoe", name: "Jane Doe" })]);
  const account = { platform: "github", handle: "janedoe", url, rationale: "" };

  test("a scrape and an API read of one profile count once; another page adds weight", () => {
    const sweep = (urls: string[]) => mkWebSweep({
      identifiers: { emails: [], socialHandles: [mkHandle("github", "janedoe", url)] },
      identifierSources: { handles: { "github:janedoe": urls }, emails: {}, freemail: {} },
    });
    const single = run({ gitHub: github });
    const duplicate = run({ gitHub: github, webSweep: sweep(["http://www.github.com/JaneDoe/?utm_source=test"]) });
    const handle = duplicate.clusters.find((c) => c.signalType === "handle")!;
    expect(handle.independentSources).toBe(1);
    expect(duplicate.score).toBe(single.score);
    const independent = run({ gitHub: github, webSweep: sweep([url, "https://example.org/about"]) });
    expect(independent.clusters.find((c) => c.signalType === "handle")?.independentSources).toBe(2);
    expect(independent.score).toBeGreaterThan(duplicate.score);
  });

  test("POSSIBLE caps confidence; CONFIRMED is carried but adds no source", () => {
    const base = { gitHub: github, directIdentifiers: { emails: [], socialHandles: [mkHandle("github", "janedoe", url)] } };
    expect(run(base).clusters.find((c) => c.signalType === "handle")?.confidence).toBe("medium");
    const possible = run({ ...base, structured: { ...mkStructured([]), accounts: [{ ...account, status: "POSSIBLE" as const }] } });
    expect(possible.clusters.find((c) => c.signalType === "handle")?.confidence).toBe("low");
    const confirmed = run({ ...base, structured: { ...mkStructured([]), accounts: [{ ...account, status: "CONFIRMED" as const }] } });
    const handle = confirmed.clusters.find((c) => c.signalType === "handle")!;
    expect(handle.accountStatus).toBe("CONFIRMED");
    expect(handle.independentSources).toBe(run(base).clusters.find((c) => c.signalType === "handle")!.independentSources);
  });

  test("REJECTED drops an unlinked account but cannot overrule deterministic subject ownership", () => {
    const input = { username: "target_user", gitHub: github, structured: { ...mkStructured([]), accounts: [{ ...account, status: "REJECTED" as const }] } };
    expect(run(input).clusters).toEqual([]);
    expect(run(input).score).toBe(0);
    expect(run(input).rejectedAccounts).toEqual([`janedoe (${url})`]);
    expect(renderCorroborationBlock(run(input))).toContain(`Removed by REJECTED labels** (with every observation read off them): janedoe (${url})`);
    const owned = { ...input, corpusTexts: [{ text: "My github is janedoe", permalink: "/r/test/comments/abc/title/comment" }] };
    const result = run({ ...owned, identityGraph: buildIdentityGraph(owned) });
    expect(result.clusters.some((c) => c.isSubject && c.warnings?.length)).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    expect(result.rejectedAccounts).toEqual([]);
  });
});

describe("candidate hypothesis check", () => {
  function evidence(withCommits = true, linked = true): CorroborationResult {
    const input = {
      username: "fixtureveil",
      gitHub: mkGitHub([mkGitHubIdentity({
        login: "fixturenew", name: "Rao, Asha Devi",
        commitAuthors: withCommits ? ["one", "two"].map((repo) => ({
          name: "Asha Rao", email: "asha@example.com", repo: `external/${repo}`, attributedLogin: "fixturenew",
        })) : [],
      })]),
      corpusTexts: linked ? [{ text: "My github is fixturenew", permalink: "/r/test/comments/link/title/comment" }] : [],
    };
    return run({ ...input, identityGraph: buildIdentityGraph(input) });
  }

  test("matches token order/middle names against attributed commits without changing the verdict", () => {
    const result = evidence();
    const before = JSON.stringify(result);
    const check = checkCandidateHypothesis({ name: "  ASHA Rao  " }, result)!;
    expect(check.status).toBe("CONSISTENT");
    expect(check.matches.map((m) => m.value)).toEqual(["Rao, Asha Devi"]);
    expect(check.matches[0].evidence).toContain("https://github.com/external/one");
    expect(renderCandidateHypothesisBlock(check)).toContain("**CONSISTENT**");
    expect(renderCandidateHypothesisBlock(check)).toContain("[source](https://github.com/external/one)");
    expect(JSON.stringify(result)).toBe(before);
  });

  test("disjoint strong subject names conflict; a shared surname or first name stays inconclusive", () => {
    const result = evidence();
    expect(checkCandidateHypothesis({ name: "Martin Cole" }, result)?.status).toBe("CONFLICTING");
    expect(checkCandidateHypothesis({ name: "Martin Rao" }, result)?.status).toBe("INCONCLUSIVE");
    expect(checkCandidateHypothesis({ name: "Asha Cole" }, result)?.status).toBe("INCONCLUSIVE");
    expect(checkCandidateHypothesis({ name: "Rao" }, result)?.status).toBe("INCONCLUSIVE");
  });

  test("a namesake, weak single-document name, or missing evidence cannot confirm or refute the hypothesis", () => {
    for (const result of [evidence(true, false), evidence(false)]) {
      for (const name of ["Asha Rao", "Martin Cole"]) {
        expect(checkCandidateHypothesis({ name }, result)?.status).toBe("INCONCLUSIVE");
      }
    }
    expect(checkCandidateHypothesis({ name: "Asha Rao" })?.status).toBe("INCONCLUSIVE");
    expect(checkCandidateHypothesis()).toBeUndefined();
    expect(checkCandidateHypothesis({ name: " " }, evidence())).toBeUndefined();
    expect(renderCandidateHypothesisBlock()).toBe("");
  });

  test("agreement and conflicting subject names together stay inconclusive", () => {
    const result = evidence();
    const name = result.clusters.find((c) => c.signalType === "real_name")!;
    const check = checkCandidateHypothesis({ name: "Asha Rao" }, {
      ...result, clusters: [...result.clusters, { ...name, key: "other-name", value: "Maria Costa" }],
    })!;
    expect(check.status).toBe("INCONCLUSIVE");
    expect(check.matches).toHaveLength(1);
    expect(check.conflicts.map((c) => c.value)).toEqual(["Maria Costa"]);
  });
});
