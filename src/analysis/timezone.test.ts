import { describe, expect, test } from "bun:test";
import {
  estimateUtcOffset,
  formatOffsetLabel,
  renderTimezoneBlock,
  renderTimezoneContextForPrompt,
} from "./timezone.ts";

/**
 * Deterministic timezone estimator tests.
 *
 * Fixtures are built from local wall-clock times at the target offset and
 * converted to UTC — this matters because hour-class granularity makes
 * offsets 30 minutes apart indistinguishable for timestamps sitting exactly
 * on hour boundaries. Each fixture includes boundary-straddling posts
 * (e.g. local 08:15 and 21:45) so the 30-minute neighbors of the true offset
 * lose the daytime tie-break and the winner is unique.
 */

/** Unix timestamp for a given day-number and minutes-past-midnight UTC. */
const ts = (day: number, minutesUtc: number) => day * 86400 + minutesUtc * 60;

/**
 * Local wall-clock activity spread across the awake day (08:15–21:45 local),
 * with posts straddling both day-window boundaries so adjacent offsets are
 * strictly worse. Returned as UTC minute-of-day offsets from the given offset.
 */
const localMinutes = [495, 570, 600, 660, 750, 780, 840, 930, 960, 1020, 1110, 1140, 1200, 1305];
const spreadOverDays = (offsetMinutes: number, days: number[]): number[] => {
  const out: number[] = [];
  for (const d of days) {
    for (const m of localMinutes) {
      out.push(ts(d, (((m - offsetMinutes) % 1440) + 1440) % 1440));
    }
  }
  return out;
};

describe("estimateUtcOffset", () => {
  test("India-pattern activity (local day at UTC+05:30) → +330, UTC+05:30", () => {
    // 42 posts across 3 days, all inside local 08:00–22:00 at +05:30,
    // night window empty there and strictly worse at every other offset.
    const stamps = spreadOverDays(330, [19000, 19003, 19006]);
    const est = estimateUtcOffset(stamps);
    expect(est).not.toBeNull();
    expect(est!.offsetMinutes).toBe(330);
    expect(est!.label).toBe("UTC+05:30");
    expect(est!.postCount).toBe(42);
    // Runner-up also has an empty night window, but loses the daytime
    // tie-break; best night (0) <= 0.5 * runner-up night (0) → high.
    expect(est!.confidence).toBe("high");
    expect(est!.nightFraction).toBe(0);
    expect(est!.localHourHistogram).toHaveLength(24);
  });

  test("US-East-pattern activity (local day at UTC−05:00) → −300, UTC-05:00", () => {
    const stamps = spreadOverDays(-300, [19000, 19004]);
    const est = estimateUtcOffset(stamps);
    expect(est).not.toBeNull();
    expect(est!.offsetMinutes).toBe(-300);
    expect(est!.label).toBe("UTC-05:00");
    expect(est!.nightFraction).toBe(0);
  });

  test("fewer than 10 finite timestamps → null (garbage filtered first)", () => {
    const nine = spreadOverDays(330, [19000]).slice(0, 9);
    expect(estimateUtcOffset(nine)).toBeNull();
    // NaN / 0 / negative / Infinity must be filtered, not crash or count.
    expect(estimateUtcOffset([...nine, Number.NaN, 0, -12345, Number.POSITIVE_INFINITY])).toBeNull();
    expect(estimateUtcOffset([])).toBeNull();
  });

  test("near-uniform 24-hour spread → confidence low, tie collapses to UTC+00:00", () => {
    const stamps: number[] = [];
    for (let h = 0; h < 24; h++) {
      stamps.push(ts(19000, h * 60));
      stamps.push(ts(19002, h * 60 + 30));
    }
    const est = estimateUtcOffset(stamps);
    expect(est).not.toBeNull();
    expect(est!.confidence).toBe("low");
    // Every offset fits equally badly → |offset| tie-break prefers 0.
    expect(est!.offsetMinutes).toBe(0);
    expect(est!.nightFraction).toBe(est!.runnerUpNightFraction);
  });

  test("fewer than 4 distinct UTC hours → forced low confidence", () => {
    // 15 posts but all at the same UTC hour: no clock signal at all.
    const stamps = Array.from({ length: 15 }, (_, i) => ts(19000 + i, 14 * 60));
    const est = estimateUtcOffset(stamps);
    expect(est).not.toBeNull();
    expect(est!.confidence).toBe("low");
  });

  test("deterministic: same input twice → deep-equal output", () => {
    const stamps = spreadOverDays(330, [19000, 19003, 19006]);
    expect(estimateUtcOffset(stamps)).toEqual(estimateUtcOffset(stamps));
  });
});

describe("formatOffsetLabel", () => {
  test("330 → UTC+05:30, 0 → UTC+00:00, -240 → UTC-04:00", () => {
    expect(formatOffsetLabel(330)).toBe("UTC+05:30");
    expect(formatOffsetLabel(0)).toBe("UTC+00:00");
    expect(formatOffsetLabel(-240)).toBe("UTC-04:00");
  });
});

describe("render helpers", () => {
  const est = estimateUtcOffset(spreadOverDays(330, [19000, 19003, 19006]))!;

  test("report block states estimate, confidence, comparison, histogram, caveat", () => {
    const block = renderTimezoneBlock(est);
    expect(block).toContain("## Posting-Time Timezone Estimate");
    expect(block).toContain("UTC+05:30");
    expect(block).toContain("high");
    expect(block).toContain("42");
    expect(block).toContain("runner-up");
    expect(block).toContain("hour |");
    expect(block).toContain("count|");
    expect(block).toContain("Caveat");
  });

  test("prompt context is a compact ground-truth line", () => {
    const line = renderTimezoneContextForPrompt(est);
    expect(line).toContain("POSTING-TIME TIMEZONE ESTIMATE");
    expect(line).toContain("UTC+05:30");
    expect(line).toContain("42");
    expect(line).not.toContain("\n");
  });
});
