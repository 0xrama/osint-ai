import { describe, expect, test } from "bun:test";
import {
  calibrateConfidence,
  clamp,
  computeCorroboration,
  mapOverallRisk,
  maxRisk,
  nameTokens,
  normalizeEmployer,
  normalizeLocation,
  normalizeName,
  parseAge,
  renderCorroborationBlock,
} from "./corroboration.ts";
import type { CorroborationInput, CorroborationResult, CorroborationCluster } from "./corroboration.ts";
import type { StructuredFindings, Finding } from "./findings.ts";
import type { SocialHandle } from "./extract.ts";
import type { WebSweepResult } from "./web-sweep.ts";
import type { GitHubPassResult, GitHubIdentity } from "./github-pass.ts";
import type { TwitterPassResult, TwitterUserProfile } from "./twitter-pass.ts";

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
      }),
      gitHub: mkGitHub([mkGitHubIdentity({ login: "johndoe" })]),
    });
    const handles = res.clusters.filter((c) => c.signalType === "handle");
    expect(handles.length).toBe(1);
    const h = handles[0];
    expect(h.domainCount).toBe(3);
    // web: 1 platform (instagram) + github 1 + direct 1
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
          login: "johndoe",
          name: "John A. Doe",
          commitAuthors: [
            { name: "John Doe", email: "john@acme.com", repo: "johndoe/repo1", attributedLogin: "johndoe" },
            { name: "John Doe", email: "john@acme.com", repo: "johndoe/repo2", attributedLogin: "johndoe" },
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

  test("empty-evidence finding counts as 1 weak source", () => {
    const res = run({
      structured: mkStructured([mkFinding("real_name", "Jane Smith", [])]),
    });
    const name = res.clusters.find((c) => c.signalType === "real_name")!;
    expect(name.sourceBreakdown.reddit_evidence).toBe(1);
  });

  test("web platforms AND page URLs both count (capped at 3)", () => {
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
    // platform:x + url:page1 + url:page2 = 3 (cap)
    expect(h.sourceBreakdown.web).toBe(3);
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
    expect(lone.score).toBeGreaterThanOrEqual(0);
    expect(lone.score).toBeLessThanOrEqual(100);

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

  test("no permalinks anywhere → clusters still produced", () => {
    const res = run({
      structured: mkStructured([
        mkFinding("real_name", "Jane Smith", []),
        mkFinding("location", "Pune", []),
      ]),
    });
    const names = res.clusters.filter((c) => c.signalType === "real_name");
    const locs = res.clusters.filter((c) => c.signalType === "location");
    expect(names.length).toBe(1);
    expect(locs.length).toBe(1);
    expect(names[0].sourceBreakdown.reddit_evidence).toBe(1);
    expect(locs[0].sourceBreakdown.reddit_evidence).toBe(1);
  });

  test("malformed inputs never throw (total-function contract)", () => {
    const malformed = run({
      structured: {
        overallRisk: "low",
        summary: "",
        findings: [{ category: "other", nonsense: true }],
      } as any,
      directIdentifiers: { emails: [null], socialHandles: [{ platform: null, handle: null, url: null }] } as any,
      gitHub: {
        queried: [],
        identities: [{ login: "x", commitAuthors: [{ name: null }] }],
        rateLimited: false,
      } as any,
      webSweep: { username: "x", identifiers: { emails: [null], socialHandles: [null] } } as any,
    });
    expect(Array.isArray(malformed.clusters)).toBe(true);
    expect(malformed.score).toBeGreaterThanOrEqual(0);
    expect(malformed.score).toBeLessThanOrEqual(100);
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
    expect(h.sourceBreakdown.web).toBe(2); // platform:instagram + url:page.com
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
        identifierSources: { emails: {}, handles: {}, freemail: {} },
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
