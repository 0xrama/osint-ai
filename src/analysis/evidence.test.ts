import { describe, expect, test } from "bun:test";
import {
  buildVerdict,
  emptyIdentifierCollections,
  emptyVerdict,
  mergeIdentifiersForDisplay,
  type IdentifierCollections,
  type VerdictInput,
} from "./evidence.ts";
import type { DirectIdentifiers } from "./extract.ts";

const di = (emails: string[] = [], handles: Array<{ platform: string; handle: string; url: string }> = []): DirectIdentifiers => ({
  emails,
  socialHandles: handles,
});

function mkCluster(c: Partial<VerdictInput["clusters"][number]> & { signalType: string }): VerdictInput["clusters"][number] {
  return {
    independentSources: 1,
    domainCount: 1,
    corroborating: false,
    ...c,
  };
}

describe("IdentifierCollections separation", () => {
  test("empty bag has five empty domains", () => {
    const e = emptyIdentifierCollections();
    expect(e.corpus).toEqual({ emails: [], socialHandles: [] });
    expect(e.web).toEqual({ emails: [], socialHandles: [] });
    expect(e.github).toEqual({ emails: [], socialHandles: [] });
    expect(e.twitter).toEqual({ emails: [], socialHandles: [] });
    expect(e.modelMentioned).toEqual({ emails: [], socialHandles: [] });
  });

  test("mergeForDisplay dedupes corpus+web+github+twitter but EXCLUDES model-mentioned by default", () => {
    const collections: IdentifierCollections = {
      corpus: di(["a@x.com"], [{ platform: "github", handle: "jane", url: "https://github.com/jane" }]),
      web: di(["a@x.com", "b@y.com"], [{ platform: "x", handle: "jane", url: "https://x.com/jane" }]),
      github: di([], [{ platform: "github", handle: "jane", url: "https://github.com/jane" }]),
      twitter: di([], [{ platform: "x", handle: "jane", url: "https://x.com/jane" }]),
      modelMentioned: di(["hallucinated@fake.com"], [{ platform: "instagram", handle: "jane", url: "https://instagram.com/jane" }]),
    };
    const merged = mergeIdentifiersForDisplay(collections);
    // model-mentioned is excluded by default
    expect(merged.emails).not.toContain("hallucinated@fake.com");
    expect(merged.emails.sort()).toEqual(["a@x.com", "b@y.com"]);
    // handle deduped by platform:handle (github jane + x jane are distinct platforms)
    const keys = merged.socialHandles.map((h) => `${h.platform}:${h.handle.toLowerCase()}`).sort();
    expect(keys).toEqual(["github:jane", "x:jane"]);
  });

  test("mergeForDisplay(includeModel: true) folds model-mentioned in", () => {
    const collections: IdentifierCollections = {
      corpus: di([], []),
      web: di([], []),
      github: di([], []),
      twitter: di([], []),
      modelMentioned: di(["hallucinated@fake.com"], []),
    };
    expect(mergeIdentifiersForDisplay(collections).emails).toEqual([]);
    expect(mergeIdentifiersForDisplay(collections, true).emails).toEqual(["hallucinated@fake.com"]);
  });
});

describe("buildVerdict", () => {
  test("all-low empty verdict", () => {
    expect(emptyVerdict()).toEqual({
      exposureSeverity: "low",
      attributionConfidence: "low",
      evidenceQuality: "low",
      contradictions: [],
    });
  });

  test("exposureSeverity projects overallRisk", () => {
    const v = buildVerdict({ overallRisk: "high", clusters: [], contradictionStrings: [] });
    expect(v.exposureSeverity).toBe("high");
  });

  test("corroborated cross-domain strong identity → high attribution", () => {
    const v = buildVerdict({
      overallRisk: "high",
      clusters: [
        mkCluster({ signalType: "real_name", independentSources: 2, domainCount: 2, corroborating: true }),
        mkCluster({ signalType: "email", independentSources: 2, domainCount: 2, corroborating: true }),
      ],
      contradictionStrings: [],
    });
    expect(v.attributionConfidence).toBe("high");
  });

  test("identity contradiction caps high attribution to medium", () => {
    const v = buildVerdict({
      overallRisk: "high",
      clusters: [
        mkCluster({ signalType: "real_name", independentSources: 2, domainCount: 2, corroborating: true }),
      ],
      contradictionStrings: ["Conflicting real names: John vs Jane"],
    });
    expect(v.attributionConfidence).toBe("medium");
  });

  test("single-domain strong identity → medium attribution", () => {
    const v = buildVerdict({
      overallRisk: "medium",
      clusters: [mkCluster({ signalType: "email", independentSources: 1, domainCount: 1, corroborating: false })],
      contradictionStrings: [],
    });
    expect(v.attributionConfidence).toBe("medium");
  });

  test("no strong identity, no corroboration → low attribution", () => {
    const v = buildVerdict({
      overallRisk: "low",
      clusters: [mkCluster({ signalType: "location", independentSources: 1, domainCount: 1 })],
      contradictionStrings: [],
    });
    expect(v.attributionConfidence).toBe("low");
  });

  test("evidence quality rises with multi-domain breadth", () => {
    const rich = buildVerdict({
      overallRisk: "high",
      clusters: [
        mkCluster({ signalType: "location", domainCount: 2, corroborating: true }),
        mkCluster({ signalType: "employer", domainCount: 2, corroborating: true }),
        mkCluster({ signalType: "real_name", domainCount: 2, corroborating: true }),
      ],
      contradictionStrings: [],
    });
    expect(rich.evidenceQuality).toBe("high");

    const thin = buildVerdict({
      overallRisk: "low",
      clusters: [mkCluster({ signalType: "location", domainCount: 1 })],
      contradictionStrings: [],
    });
    expect(thin.evidenceQuality).toBe("low");
  });

  test("unsupported evidence lowers evidence quality", () => {
    const v = buildVerdict({
      overallRisk: "high",
      clusters: [
        mkCluster({ signalType: "location", domainCount: 2, corroborating: true }),
        mkCluster({ signalType: "employer", domainCount: 2, corroborating: true }),
        mkCluster({ signalType: "real_name", domainCount: 2, corroborating: true }),
      ],
      contradictionStrings: [],
      evidenceValidation: { checked: 10, supported: 3, unsupported: 7 },
    });
    // 70% unsupported → not high; corroborated>=2 but unsupportedRatio 0.7 > 0.3 → low
    expect(v.evidenceQuality).toBe("low");
  });

  test("contradictions are typed", () => {
    const v = buildVerdict({
      overallRisk: "medium",
      clusters: [],
      contradictionStrings: ["Conflicting locations: Hyderabad vs Bengaluru", "Conflicting real names: A vs B"],
    });
    expect(v.contradictions.map((c) => c.signalType).sort()).toEqual(["location", "real_name"]);
  });
});
