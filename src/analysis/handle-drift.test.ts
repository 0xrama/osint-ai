import { describe, expect, test } from "bun:test";
import { generateDriftVariants, groupDriftKeys, isDriftVariant } from "./handle-drift.ts";

/**
 * Pure-function tests for the shared handle-drift machinery (no network, no
 * deps). Fixtures are synthetic handles; nothing here is target-specific.
 */

describe("handle-drift: generateDriftVariants", () => {
  test("contains the base spelling and the l→1 drift spelling", () => {
    const v = generateDriftVariants("fixtureveil");
    expect(v).toContain("fixtureveil");
    expect(v).toContain("fixtureve1l");
  });

  test("separator drift is normalized away before expansion", () => {
    const a = generateDriftVariants("fixture.veil");
    const b = generateDriftVariants("fixtureveil");
    expect([...a].sort()).toEqual([...b].sort());
  });

  test("deterministic: identical output across calls", () => {
    expect(generateDriftVariants("fixtureveil")).toEqual(generateDriftVariants("fixtureveil"));
    expect(generateDriftVariants("johndoe")).toEqual(generateDriftVariants("johndoe"));
  });

  test("very short handles return just the normalized base", () => {
    expect(generateDriftVariants("a")).toEqual(["a"]);
    expect(generateDriftVariants("")).toEqual([""]);
  });
});

describe("handle-drift: isDriftVariant", () => {
  test("digit/letter confusable pairs match in both directions", () => {
    expect(isDriftVariant("fixtureve1l", "fixtureveil")).toBe(true);
    expect(isDriftVariant("fixtureveil", "fixtureve1l")).toBe(true);
    expect(isDriftVariant("j0hnd0e", "johndoe")).toBe(true);
  });

  test("unrelated handles do not match", () => {
    expect(isDriftVariant("fixtureveil", "fixturenew")).toBe(false);
    expect(isDriftVariant("john", "jane")).toBe(false);
  });
});

describe("handle-drift: groupDriftKeys", () => {
  test("groups drift spellings into one family (l→1 drift)", () => {
    const groups = groupDriftKeys(["fixtureveil", "fixtureve1l", "johndoe"]);
    expect(groups.length).toBe(2);
    const family = groups.find((g) => g.includes("fixtureveil"))!;
    expect(family).toContain("fixtureve1l");
  });

  test("the ambiguous 1 (i AND l both drift to 1) groups from both directions", () => {
    // fixturevei1 is the l→1 spelling, fixtureve1l the i→1 spelling.
    const groups = groupDriftKeys(["fixtureveil", "fixtureve1l", "fixturevei1"]);
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(3);
  });

  test("short keys (< 5 chars) never drift-group: bool vs bo0 stay apart", () => {
    // Keys below the min length are not eligible at all → no groups emitted.
    expect(groupDriftKeys(["bool", "bo0"])).toEqual([]);
  });

  test("unrelated long handles stay in their own groups", () => {
    const groups = groupDriftKeys(["fixtureveil", "completelydifferent"]);
    expect(groups.length).toBe(2);
  });

  test("deterministic up to group/key ordering", () => {
    const a = groupDriftKeys(["fixtureveil", "fixtureve1l"]).map((g) => [...g].sort()).sort();
    const b = groupDriftKeys(["fixtureve1l", "fixtureveil"]).map((g) => [...g].sort()).sort();
    expect(a).toEqual(b);
  });
});
