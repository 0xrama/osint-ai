/**
 * Bounded-concurrency map. Network passes (sweep searches/scrapes, GitHub,
 * probes) were awaited one request at a time; this runs up to `limit` in
 * flight while returning results in INPUT order, so downstream ranking —
 * which handle/bridge is seen first — stays deterministic.
 *
 * A rejected task rejects the whole map, like Promise.all: callers keep
 * their per-item try/catch inside `fn` (AGENTS.md resilience rule).
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
