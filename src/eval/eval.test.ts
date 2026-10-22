import { describe, expect, test } from "bun:test";
import { runEvalSuite, formatEvalReport } from "./runner.ts";
import { FIXTURES } from "./fixtures.ts";
import type { EvalFixture } from "./schema.ts";

/** Helper: pick fixtures matching given categories. */
function pick(categories: string[]): EvalFixture[] {
  const set = new Set(categories);
  return FIXTURES.filter((f) => f.categories.some((c) => set.has(c)));
}

describe("eval suite: per-category acceptance gates", () => {
  test("bridge detection — at least one bridge-owner handle found", async () => {
    const ag = await runEvalSuite(pick(["bridge"]));
    expect(ag.failures).toEqual([]);
    // bridge-1's scraped GitHub page names the audited handle: the sweep must
    // find exactly that bridge owner and no other.
    const m = ag.perFixture.find((x) => x.fixtureId === "bridge-1")!;
    expect(m.bridgeRecall).toBe(1);
    expect(m.bridgePrecision).toBe(1);
    expect(ag.meanIdentifierF1).toBeGreaterThanOrEqual(0.2);
  });

  // ──────────── More context needed for these fixtures ────────────────
  // unrelated-1 / common-username-1: The system correctly extracts
  // identifiers from scraped profiles, but the eval can't distinguish
  // "same-person" from "lookalike" without Reddit history providing
  // negative signal (the system needs both sides of the comparison).
  // vendor-email-1 exercises the injected personal-site follower so the
  // deterministic suite remains network-free.

  test("unrelated matching username — no false bridges attributed", async () => {
    const ag = await runEvalSuite(pick(["unrelated-handle"]));
    expect(ag.failures).toEqual([]);
    const m = ag.perFixture.find((x) => x.fixtureId === "unrelated-1")!;
    // The scraped page IS extracted (it carries real identity data).
    // Attribution top-1 may fire because the GitHub profile has name/email.
    // The key test: bridge edges are NOT claimed for unrelated lookalikes.
    expect(m.bridgeFalsePositiveRate).toBe(0);
  });

  test("common username — sweep runs without errors", async () => {
    const ag = await runEvalSuite(pick(["common-username"]));
    expect(ag.failures).toEqual([]);
    // Three profiles scraped for "john" — may produce handles as identifiers
    // (they were genuinely scraped), but none may be attributed as the subject.
    const m = ag.perFixture.find((x) => x.fixtureId === "common-username-1")!;
    expect(m.attributionTop1Correct).toBe(true);
  });

  test("collaborator commits — collaborator emails excluded from identifiers", async () => {
    const ag = await runEvalSuite(pick(["collaborator-commit"]));
    expect(ag.failures).toEqual([]);
    const m = ag.perFixture.find((x) => x.fixtureId === "collaborator-commit-1")!;
    // Key invariant: collaborator emails (bob@, carol@) must NEVER appear.
    expect(m.falsePositives.filter((fp) => fp.includes("bob") || fp.includes("carol")).length).toBe(0);
    // Owner emails should be found (at least one).
    const foundOwner = m.truePositives.filter((tp) =>
      tp.includes("alice@personal.dev") || tp.includes("alice@company.com"),
    );
    expect(foundOwner.length).toBeGreaterThanOrEqual(1);
  });

  test("vendor emails — real contact kept, footer vendor mailboxes dropped", async () => {
    const ag = await runEvalSuite(pick(["vendor-email"]));
    expect(ag.failures).toEqual([]);
    const m = ag.perFixture.find((x) => x.fixtureId === "vendor-email-1")!;
    expect(m.truePositives.some((tp) => tp.includes("devninja@proton.me"))).toBe(true);
    expect(m.falsePositives.filter((fp) => fp.includes("@vendor.com"))).toEqual([]);
  });

  test("distractor search results — snippet-only emails excluded", async () => {
    const ag = await runEvalSuite(pick(["distractor"]));
    expect(ag.failures).toEqual([]);
    const m = ag.perFixture.find((x) => x.fixtureId === "distractor-1")!;
    // The distractor email (researcher42@gmail.com) appears in the search
    // snippet but NEVER on an actually-scraped page → must not be extracted.
    expect(m.falsePositives.filter((fp) => fp.includes("researcher42@gmail.com")).length).toBe(0);
    expect(m.identifierPrecision).toBe(1.0);
  });

  test("renamed handle bridge — detection correct", async () => {
    const ag = await runEvalSuite(pick(["renamed-handle"]));
    expect(ag.failures).toEqual([]);
    const m = ag.perFixture.find((x) => x.fixtureId === "renamed-1")!;
    expect(m.bridgeRecall).toBeGreaterThanOrEqual(0.5);
    expect(m.identifierF1).toBeGreaterThanOrEqual(0.5);
  });

  test("conflicting signals — contradiction flagged", async () => {
    const ag = await runEvalSuite(pick(["conflicting-signal"]));
    expect(ag.failures).toEqual([]);
    const m = ag.perFixture.find((x) => x.fixtureId === "conflicting-1")!;
    // Two locations (Mumbai/Berlin) and two names (Raj/Alex) should trigger
    // a contradiction.
    expect(m.contradictionCorrect).toBe(true);
  });

  test("no resolvable identity — top-1 correct", async () => {
    const ag = await runEvalSuite(pick(["no-identity"]));
    expect(ag.failures).toEqual([]);
    const m = ag.perFixture.find((x) => x.fixtureId === "no-identity-1")!;
    expect(m.attributionTop1Correct).toBe(true);
  });

  test("partial archive — identifiers from thin data still found", async () => {
    const ag = await runEvalSuite(pick(["partial-archive"]));
    expect(ag.failures).toEqual([]);
    const m = ag.perFixture.find((x) => x.fixtureId === "partial-1")!;
    // Limited data still yields identifiers (email + GitHub handle)
    expect(m.identifierRecall).toBeGreaterThanOrEqual(0.3);
    // Precision must not take hits (no invented data from thin corpus)
    expect(m.identifierPrecision).toBeGreaterThanOrEqual(0.9);
  });

  test("deleted content — surviving item identifiers found", async () => {
    const ag = await runEvalSuite(pick(["deleted-content"]));
    expect(ag.failures).toEqual([]);
    const m = ag.perFixture.find((x) => x.fixtureId === "deleted-1")!;
    // ghost@shadow.dev lives in a non-deleted item → must be found.
    expect(m.identifierRecall).toBeGreaterThanOrEqual(0.5);
    // [deleted] body placeholders must not produce synthetic identifiers.
    expect(m.identifierPrecision).toBe(1.0);
  });
});

describe("eval suite: full regression sweep", () => {
  test("all 14 fixtures pass without errors", async () => {
    const ag = await runEvalSuite(FIXTURES);
    expect(ag.failures).toEqual([]);
    expect(ag.fixtureCount).toBe(14);
    // Every category has at least one fixture.
    expect(Object.keys(ag.categoryCoverage).length).toBeGreaterThanOrEqual(9);
  });

  test("aggregate bridge F1 is perfect", async () => {
    const ag = await runEvalSuite(FIXTURES);
    expect(ag.meanBridgeF1).toBe(1);
  });

  test("aggregate identifier F1 >= 0.77", async () => {
    const ag = await runEvalSuite(FIXTURES);
    expect(ag.meanIdentifierF1).toBeGreaterThanOrEqual(0.77);
  });

  test("contradiction accuracy is perfect", async () => {
    const ag = await runEvalSuite(FIXTURES);
    expect(ag.contradictionAccuracy).toBe(1);
  });

  // Ratchet floors: raise them when a fix lifts the number, never lower them.
  // calibrateConfidence's constants are already grid-fitted.
  test("fusion and risk calibration floors", async () => {
    const ag = await runEvalSuite(FIXTURES);
    expect(ag.meanFusionRecall).toBe(1);
    expect(ag.fusionFalseLinkCount).toBe(0);
    expect(ag.riskAccuracy).toBe(1);
    // A handle containing the audited name as a hyphen token (john-dev ⊃ john)
    // is not a bridge and must not fuse into the subject.
    expect(ag.perFixture.find((m) => m.fixtureId === "common-username-1")!.fusionFalseLinks).toEqual([]);
  });

  test("report renders without error", () => {
    const dummy = {
      fixtureCount: 11,
      categoryCoverage: { bridge: 2 },
      meanIdentifierF1: 0.85,
      meanCitationValidity: 1.0,
      meanBridgeF1: 0.75,
      meanCandidateLinkPrecision: 0.9,
      attributionTop1Rate: 0.8,
      contradictionAccuracy: 0.9,
      meanFusionRecall: 0.8,
      fusionFalseLinkCount: 0,
      riskAccuracy: 0.75,
      perFixture: [],
      failures: [],
    };
    const report = formatEvalReport(dummy);
    expect(report).toContain("# Eval Report");
    expect(report).toContain("Aggregate");
  });
});
