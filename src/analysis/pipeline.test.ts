import { describe, expect, test } from "bun:test";
import { phaseTimer, slowestPhases } from "./pipeline.ts";

/**
 * runAudit phase-timing helpers. runAudit itself needs network + LLM, so
 * only the pure timing pieces are covered here.
 */
describe("phaseTimer", () => {
  test("records and logs a phase, passing the result through", async () => {
    const lines: string[] = [];
    const { ms, time } = phaseTimer((m) => lines.push(m));
    const value = await time("web sweep", async () => 42);
    expect(value).toBe(42);
    expect(ms["web sweep"]).toBeGreaterThanOrEqual(0);
    expect(lines).toEqual([expect.stringMatching(/^\[timing\] web sweep: \d+\.\ds$/)]);
  });

  test("records a failed phase and rethrows", async () => {
    const { ms, time } = phaseTimer(() => {});
    await expect(time("probes", () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(ms.probes).toBeGreaterThanOrEqual(0);
  });
});

describe("slowestPhases", () => {
  test("lists the n slowest phases, slowest first", () => {
    const summary = slowestPhases({ "web sweep": 98_000, synthesis: 312_400, graph: 5, probes: 1_500 }, 2);
    expect(summary).toBe("synthesis 312.4s, web sweep 98.0s");
  });

  test("empty input yields an empty summary", () => {
    expect(slowestPhases({})).toBe("");
  });
});
