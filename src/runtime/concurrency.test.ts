import { expect, test } from "bun:test";
import { mapLimit } from "./concurrency.ts";

test("mapLimit keeps input order and never exceeds the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([30, 5, 20, 1, 10], 2, async (ms, i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Bun.sleep(ms);
    inFlight--;
    return i;
  });
  expect(out).toEqual([0, 1, 2, 3, 4]);
  expect(peak).toBe(2);
  expect(await mapLimit([], 4, async () => 1)).toEqual([]);
});
