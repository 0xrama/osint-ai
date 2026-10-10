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
 * converted to UTC. The estimate is the midpoint of the plateau of offsets
 * with the fewest local 01:00–07:00 posts, i.e. it centres the subject's quiet
 * gap on local 04:00; the main fixture's gap (00:30–07:15) straddles both
 * window edges so only the true offset empties the window (a sharp fit).
 */

/** Unix timestamp for a given day-number and minutes-past-midnight UTC. */
const ts = (day: number, minutesUtc: number) => day * 86400 + minutesUtc * 60;

/**
 * Local wall-clock activity across a typical awake day (07:15–00:30 local),
 * with posts just outside both night-window edges so every other offset puts
 * at least one post into local 01:00–07:00. Returned as UTC timestamps.
 */
const localMinutes = [435, 495, 570, 600, 660, 750, 780, 840, 930, 960, 1020, 1110, 1140, 1200, 1305, 1380, 1425, 1470];
const spreadOverDays = (offsetMinutes: number, days: number[], minutes = localMinutes): number[] => {
  const out: number[] = [];
  for (const d of days) {
    for (const m of minutes) {
      out.push(ts(d, (((m - offsetMinutes) % 1440) + 1440) % 1440));
    }
  }
  return out;
};

describe("estimateUtcOffset", () => {
  test("India-pattern activity (local day at UTC+05:30) → +330, UTC+05:30", () => {
    // 54 posts across 3 days; the night window is empty only at +05:30.
    const stamps = spreadOverDays(330, [19000, 19003, 19006]);
    const est = estimateUtcOffset(stamps);
    expect(est).not.toBeNull();
    expect(est!.offsetMinutes).toBe(330);
    expect(est!.label).toBe("UTC+05:30");
    expect(est!.postCount).toBe(54);
    // Sharp plateau (one offset) and strong contrast with the median offset.
    expect(est!.plateauFromMinutes).toBe(330);
    expect(est!.plateauToMinutes).toBe(330);
    expect(est!.medianNightFraction).toBeGreaterThan(0.1);
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
    // Every offset fits equally badly → the plateau is the whole grid → 0.
    expect(est!.offsetMinutes).toBe(0);
    expect(est!.nightFraction).toBe(est!.medianNightFraction);
  });

  test("night owl (active 09:00–24:00 at +05:30) is not skewed west", () => {
    // Daytime-maximizing tie-break used to answer UTC+04:30 "high" here.
    const owlMinutes = Array.from({ length: 30 }, (_, i) => 540 + ((i * 137) % 900));
    const est = estimateUtcOffset(spreadOverDays(330, [19000, 19003], owlMinutes))!;
    expect(est.nightFraction).toBe(0);
    expect(est.plateauFromMinutes).toBeLessThanOrEqual(330);
    expect(est.plateauToMinutes).toBeGreaterThanOrEqual(330);
    expect(Math.abs(est.offsetMinutes - 330)).toBeLessThanOrEqual(30);
    // Several offsets empty the window equally: a 3-hour plateau is not "high".
    expect(est.confidence).toBe("medium");
  });

  test("zero-vs-zero ties across a wide plateau never yield high confidence", () => {
    // 16-hour day (07:00–23:00): a 2-hour plateau of empty night windows.
    const dayMinutes = Array.from({ length: 30 }, (_, i) => 420 + ((i * 137) % 960));
    const est = estimateUtcOffset(spreadOverDays(60, [19000, 19002], dayMinutes))!;
    expect(est.plateauToMinutes - est.plateauFromMinutes).toBeGreaterThan(60);
    expect(est.confidence).not.toBe("high");
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
    expect(block).toContain("54");
    expect(block).toContain("median offset");
    expect(block).toContain("hour |");
    expect(block).toContain("count|");
    expect(block).toContain("Caveat");
  });

  test("prompt context is a compact ground-truth line", () => {
    const line = renderTimezoneContextForPrompt(est);
    expect(line).toContain("POSTING-TIME TIMEZONE ESTIMATE");
    expect(line).toContain("UTC+05:30");
    expect(line).toContain("54");
    expect(line).not.toContain("\n");
  });
});
