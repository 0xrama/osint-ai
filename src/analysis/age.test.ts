/**
 * Tests for the deterministic degree-timeline age estimator.
 *
 * Each case pins the arithmetic the synthesis prompt can only ask the model
 * to perform (AGENTS.md gotcha #4): milestone → enrollment year → birth
 * year → current age, with the education norms applied as code.
 */

import { describe, expect, test } from "bun:test";
import {
  estimateAges,
  parseEducationTimelines,
  renderAgeBlock,
  type AgeEstimate,
} from "./age.ts";

const NOW = new Date("2026-10-03T00:00:00Z");

describe("estimateAges", () => {
  test("2nd-year BSc stated near Nov 2024 → enrolled ~2023, born ~2005, age 20–21, medium", () => {
    const texts = ["posted Nov 2024 — honestly I'm in my 2nd year of my BSc and it's rough"];
    const estimates = estimateAges(texts, NOW);
    const edu = estimates.filter((e) => e.program === "bachelor");
    expect(edu.length).toBeGreaterThanOrEqual(1);
    const est = edu[0];
    expect(est.confidence).toBe("medium");
    // 2nd year in 2024 → enrolled 2024−1=2023 → born 2023−18=2005.
    expect(est.birthYearRange[0]).toBeLessThanOrEqual(2005);
    expect(est.birthYearRange[1]).toBeGreaterThanOrEqual(2005);
    // Born 2005 at 2026-10-03 → 20 or 21 depending on birthday timing.
    expect(est.ageRange[0]).toBeLessThanOrEqual(20);
    expect(est.ageRange[1]).toBeGreaterThanOrEqual(21);
    expect(est.ageRange[1] - est.ageRange[0]).toBeLessThanOrEqual(2);
    // The chain spells out the start-age norm (18).
    expect(est.chain).toContain("18");
    expect(est.chain).toContain("2023");
    expect(est.basis.length).toBeGreaterThan(0);

    // Parser-level check: stated-during with ordinal 2.
    const milestones = parseEducationTimelines(texts.join("\n"));
    expect(milestones.length).toBeGreaterThanOrEqual(1);
    expect(milestones.some((m) => m.program === "bachelor" && m.year === 2024 && m.yearKind === "stated-during")).toBe(true);
  });

  test("graduated B.Tech in 2021 → born ~1999 window (duration ambiguity), mid-20s+", () => {
    const estimates = estimateAges(["I graduated B.Tech in 2021 and have been working since"], NOW);
    const edu = estimates.filter((e) => e.program === "bachelor");
    expect(edu.length).toBe(1);
    const est = edu[0];
    expect(est.confidence).toBe("medium");
    // 2021 − 4-year program = enrolled ~2017 → born ~1999, ±1 widening.
    expect(est.birthYearRange[0]).toBeLessThanOrEqual(1999);
    expect(est.birthYearRange[1]).toBeGreaterThanOrEqual(1999);
    // Wide enough to absorb 3-vs-4-year programs, narrow enough to be mid/late 20s.
    expect(est.birthYearRange[1] - est.birthYearRange[0]).toBeLessThanOrEqual(2);
    expect(est.ageRange[0]).toBeGreaterThanOrEqual(23);
    expect(est.ageRange[1]).toBeLessThanOrEqual(30);
  });

  test("doing my master's, started in 2022 → born ~2001", () => {
    const estimates = estimateAges(["right now I'm doing my master's, started in 2022"], NOW);
    const edu = estimates.filter((e) => e.program === "master");
    expect(edu.length).toBe(1);
    const est = edu[0];
    expect(est.confidence).toBe("medium");
    // Started a master's at ~21 in 2022 → born 2001.
    expect(est.birthYearRange[0]).toBeLessThanOrEqual(2001);
    expect(est.birthYearRange[1]).toBeGreaterThanOrEqual(2001);
    expect(est.birthYearRange[1] - est.birthYearRange[0]).toBeLessThanOrEqual(2);
    expect(est.chain).toContain("21");
  });

  test("bracket-only ('in my twenties', no year) → low confidence, wide range", () => {
    const estimates = estimateAges(["no dates at all in this one, just: I'm in my twenties lol"], NOW);
    expect(estimates.filter((e) => e.program !== "bracket")).toEqual([]);
    const brackets = estimates.filter((e) => e.program === "bracket");
    expect(brackets.length).toBe(1);
    const est = brackets[0];
    expect(est.confidence).toBe("low");
    expect(est.ageRange).toEqual([20, 29]);
    expect(est.birthYearRange[1] - est.birthYearRange[0]).toBeGreaterThanOrEqual(9);
  });

  test("no education signal → empty estimates and empty block", () => {
    const estimates = estimateAges(["just talking about bikes and coffee, nothing personal"], NOW);
    expect(estimates).toEqual([]);
    expect(renderAgeBlock(estimates, NOW)).toBe("");
  });

  test("deterministic: same inputs → deep-equal outputs (estimates and block)", () => {
    const texts = [
      "back in 2020 I was in my 1st year of college",
      "graduated with a BSc in 2019, then started my MSc in 2022",
    ];
    const a: AgeEstimate[] = estimateAges(texts, NOW);
    const b: AgeEstimate[] = estimateAges(texts, NOW);
    expect(a).toEqual(b);
    expect(renderAgeBlock(a, NOW)).toBe(renderAgeBlock(b, NOW));
  });
});

describe("renderAgeBlock", () => {
  test("renders the framing line, chains, and flags disagreement loudly", () => {
    const estimates = estimateAges(
      ["I'm in my 3rd year of my BSc (Nov 2024 diary entry)", "I graduated my B.Com back in 2015"],
      NOW,
    );
    const block = renderAgeBlock(estimates, NOW);
    expect(block).toContain("## Deterministic Age Estimate");
    expect(block).toContain("cannot contradict this without new evidence");
    expect(block).toContain("Chain:");
    expect(block).toContain("Basis:");
    // The two timelines disagree (born ~2005 vs ~1993) → loud conflict flag.
    expect(block).toContain("⚠ CONFLICT");
  });

  test("single agreeing estimate renders a consensus line, no conflict", () => {
    const estimates = estimateAges(["in my 2nd year of B.Tech, fall 2024"], NOW);
    const block = renderAgeBlock(estimates, NOW);
    expect(block).toContain("Consensus");
    expect(block).not.toContain("⚠ CONFLICT");
  });
});
