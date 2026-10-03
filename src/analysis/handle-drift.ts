/**
 * Digit/letter handle-drift machinery — shared across deterministic passes.
 *
 * People re-spell their own handle with confusable characters when a platform
 * (or they themselves) swap letters for lookalike digits: `fixtureveil` becomes
 * `fixtureve1l` (l→1), `johndoe` becomes `j0hnd0e` (o→0). Search engines treat
 * these as different strings, so the same person splits into two "identities"
 * the moment one platform profile uses a drifted spelling.
 *
 * This module centralizes the confusable map and the two operations built on
 * it, so drift awareness is a SWEEP-WIDE concern rather than a Twitter-triage
 * special case:
 *   - `generateDriftVariants`: the bounded Cartesian set of drifted spellings
 *     (used as round-2 snowball SEARCH seeds, catching drift-registered
 *     profiles on platforms beyond X).
 *   - `isDriftVariant`: pairwise drift test (used to triage follow graphs).
 *   - `groupDriftKeys`: families of separator-normalized keys that are drift
 *     variants of each other (min-length guarded), used by the sweep's handle
 *     clustering so `fixtureveil` (GitHub) and `fixtureve1l` (X) merge into
 *     one cross-platform cluster instead of two singles.
 *
 * Pure and fetch-free by construction — deterministic layers only.
 */

import { normalizeHandleKey } from "./extract.ts";

/** Letter↔digit confusables for handle drift (fixtureve1l vs fixtureveil). */
const LETTER_TO_DIGIT: Record<string, string> = {
  a: "4", b: "8", e: "3", g: "9", i: "1", l: "1", o: "0", s: "5", t: "7", z: "2",
};
const DIGIT_TO_LETTER: Record<string, string> = {
  "0": "o", "1": "l", "2": "z", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g",
};

/**
 * All digit/letter-drift variants of a handle (bounded Cartesian expansion —
 * handles are short and few chars are confusable, so this stays tiny).
 * `generateDriftVariants("fixtureveil")` includes "fixtureve1l", "fixtur3veil", …
 */
export function generateDriftVariants(handle: string, maxVariants = 64): string[] {
  const base = normalizeHandleKey(handle);
  if (base.length < 2) return [base];
  const choices: string[][] = [];
  for (const ch of base) {
    const set = new Set<string>([ch]);
    const mapped = LETTER_TO_DIGIT[ch] ?? DIGIT_TO_LETTER[ch];
    if (mapped) set.add(mapped);
    choices.push([...set]);
  }
  const out = new Set<string>();
  const recurse = (idx: number, acc: string): void => {
    if (out.size >= maxVariants) return;
    if (idx === choices.length) { out.add(acc); return; }
    for (const c of choices[idx]) recurse(idx + 1, acc + c);
  };
  recurse(0, "");
  return [...out];
}

/** True when a and b are drift variants of each other (either direction). */
export function isDriftVariant(a: string, b: string): boolean {
  const av = generateDriftVariants(a, 32);
  const bv = generateDriftVariants(b, 32);
  return av.some((v) => bv.includes(v)) || bv.some((v) => av.includes(v));
}

/**
 * Group unique separator-normalized handle keys into drift families (keys
 * that are digit/letter drift variants of each other). Used by the sweep's
 * handle clustering so `fixtureveil` (GitHub) and `fixtureve1l` (X) merge
 * into one cross-platform identity instead of two singles.
 *
 * Pairwise (union-find) rather than a single canonical digit→letter key,
 * because the confusable map is not injective: both `i` and `l` drift to
 * `1`, so no one-way canonical form can collide `ve1l` with `veil` AND `vei1`
 * with `veil` at the same time. The pairwise `isDriftVariant` relation is the
 * ground truth; handles-per-run counts make the O(n²) pass trivial.
 *
 * GUARD: keys shorter than `minLen` (default 5) never drift-group — short
 * handles collide catastrophically ("bo0" vs "bool"). Callers still own
 * reserved-word hygiene; this function never invents new keys, it only
 * groups the ones it is given.
 */
export function groupDriftKeys(keys: string[], minLen = 5): string[][] {
  const eligible = [...new Set(keys)].filter((k) => k.length >= minLen);
  const parent = new Map<string, string>(eligible.map((k) => [k, k]));
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      if (isDriftVariant(eligible[i], eligible[j])) union(eligible[i], eligible[j]);
    }
  }
  const groups = new Map<string, string[]>();
  for (const k of eligible) {
    const root = find(k);
    groups.set(root, [...(groups.get(root) ?? []), k]);
  }
  return [...groups.values()];
}
