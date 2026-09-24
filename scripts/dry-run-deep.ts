/**
 * Dry-run validation of the deterministic deep-scan plumbing (no LLM calls).
 *
 * Loads the cached haemyu JSONL, runs heuristicFilter → categorizeItems →
 * rankAndCapBucket, and prints per-domain: raw bucket size, kept after cap,
 * drops, and estimated chunk count (chunk = 180 items / 90k chars).
 *
 *   bun run scripts/dry-run-deep.ts <username>
 */
import { loadJsonlFiles } from "../src/reddit/download.ts";
import { heuristicFilter } from "../src/analysis/filter.ts";
import { categorizeItems, DOMAINS } from "../src/analysis/deep-analysis.ts";
import { buildKeywordWeights, rankAndCapBucket, handleKey, maxItemsPerDomain } from "../src/analysis/rank.ts";

const username = process.argv[2] ?? "haemyu";
const [posts, comments] = await Promise.all([
  loadJsonlFiles("data", username, "posts").catch(() => []),
  loadJsonlFiles("data", username, "comments").catch(() => []),
]);
console.log(`raw: ${posts.length} posts, ${comments.length} comments`);

const typedPosts = posts.map((p: any) => ({
  id: p.id ?? "", title: p.title ?? "", selftext: p.selftext ?? "", author: p.author ?? "",
  subreddit: p.subreddit ?? "", created_utc: p.created_utc ?? 0, score: p.score ?? 0,
  num_comments: p.num_comments ?? 0, url: p.url ?? "", permalink: p.permalink ?? "",
  is_deleted: p.selftext === "[deleted]" || p.author === "[deleted]",
  is_removed: p.selftext === "[removed]", source: "jsonl",
}));
const typedComments = comments.map((c: any) => ({
  id: c.id ?? "", body: c.body ?? "", author: c.author ?? "", subreddit: c.subreddit ?? "",
  created_utc: c.created_utc ?? 0, score: c.score ?? 0, permalink: c.permalink ?? "",
  link_id: c.link_id ?? "", is_deleted: c.body === "[deleted]" || c.author === "[deleted]",
  is_removed: c.body === "[removed]", source: "jsonl",
}));

const { kept } = heuristicFilter(typedPosts, typedComments);
console.log(`after heuristic filter: ${kept.length}`);

const buckets = categorizeItems(kept);
const cap = maxItemsPerDomain();
console.log(`cap per domain: ${cap}\n`);

let totalKept = 0;
for (const domain of DOMAINS) {
  const bucket = buckets.get(domain.id) ?? [];
  const ctx = {
    keywordWeights: buildKeywordWeights(domain.keywords),
    subreddits: domain.subreddits.map((s) => s.toLowerCase()),
    knownHandleKeys: [username.toLowerCase(), handleKey(username)],
  };
  const { kept: capped, droppedByCap, droppedByFloor } = rankAndCapBucket(bucket, ctx, cap);
  // rough chunk estimate mirroring splitItemsForAgent's item-count check
  const chunks = Math.max(1, Math.ceil(capped.length / 180));
  totalKept += capped.length;
  console.log(
    `${domain.icon} ${domain.label.padEnd(26)} raw=${String(bucket.length).padStart(5)}  kept=${String(capped.length).padStart(5)}  floor-dropped=${String(droppedByFloor).padStart(5)}  cap-dropped=${String(droppedByCap).padStart(5)}  chunks(est)=${chunks}`,
  );
  // char sanity: would any kept bucket exceed the 90k char ceiling?
  const chars = capped.reduce((n, i) => n + 180 + Math.min(1200, (i.body ?? "").length) + Math.min(220, (i.title ?? "").length), 0);
  if (chars > 90_000) console.log(`   ⚠ char overflow: ~${(chars / 1000).toFixed(0)}k chars → would split by char limit`);
}
console.log(`\ntotal item-instances sent to sub-agents: ${totalKept} (old fanout would have been ~${kept.length * DOMAINS.length}+)`);
