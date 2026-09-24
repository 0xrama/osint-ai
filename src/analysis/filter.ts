/**
 * Heuristic comment relevance pre-filter for the deep-analysis pipeline.
 *
 * Removes clearly uninformative items (empty, very short, pure URLs,
 * bot patterns, single-word fillers) before the domain sub-agents run.
 * Deleted/removed items with meaningful body text are kept — deleted
 * content is often the most revealing.
 */

import type { RedditPost, RedditComment } from "../reddit/fetch.ts";
import type { FilteredItem } from "../types.ts";

// ── Heuristic filter ─────────────────────────────────────────────────────

const URL_ONLY_RE = /^https?:\/\/\S+$/;
const BOT_NAMES = new Set([
	"automoderator", "autobot", "bot", "modbot", "remindmebot",
	"wiki-bot", "wikipedia-bot", "youtubebot", "imagebot",
]);

/**
 * Heuristic pre-filter.
 * Removes items that are clearly uninformative without LLM involvement.
 * Keeps deleted/removed items that still have meaningful body text
 * (unlike the paper, which filters them — deleted content is often the most revealing).
 */
export function heuristicFilter(
	posts: RedditPost[],
	comments: RedditComment[],
): { kept: FilteredItem[]; filtered: FilteredItem[] } {
	const kept: FilteredItem[] = [];
	const filtered: FilteredItem[] = [];

	const toFilteredItem = (
		item: RedditPost | RedditComment,
		type: "post" | "comment",
	): FilteredItem => ({
		id: item.id,
		type,
		subreddit: item.subreddit,
		author: item.author,
		created_utc: item.created_utc,
		body: type === "post" ? (item as RedditPost).selftext : (item as RedditComment).body,
		title: type === "post" ? (item as RedditPost).title : undefined,
		is_deleted: item.is_deleted,
		is_removed: item.is_removed,
		score: item.score,
		permalink: item.permalink,
		url: type === "post" ? (item as RedditPost).url : undefined,
		source: item.source,
	});

	const shouldFilter = (item: FilteredItem): string | null => {
		const text = item.body?.trim() ?? "";
		const title = item.title?.trim() ?? "";

		// Bot accounts
		if (item.author && BOT_NAMES.has(item.author.toLowerCase())) return "bot_author";

		// Empty or placeholder text
		if (!text && !title) return "empty";
		if (text === "[deleted]" && !title) return "deleted_no_content";
		if (text === "[removed]" && !title) return "removed_no_content";

		// Very short comments (≤3 chars) with no title signal
		if (item.type === "comment" && text.length <= 3 && !title) return "too_short";

		// Pure URL comments (no surrounding context)
		if (item.type === "comment" && URL_ONLY_RE.test(text)) return "url_only";

		// Single-word filler responses
		const singleWordFillers = ["yes", "no", "lol", "lmao", "ok", "true", "same", "this", "thanks", "agreed", "exactly", "indeed", "wow", "damn", "nice", "cool"];
		if (item.type === "comment" && singleWordFillers.includes(text.toLowerCase())) return "filler";

		return null;
	};

	for (const p of posts) {
		const item = toFilteredItem(p, "post");
		const reason = shouldFilter(item);
		if (reason) {
			item.filter_reason = reason;
			filtered.push(item);
		} else {
			kept.push(item);
		}
	}

	for (const c of comments) {
		const item = toFilteredItem(c, "comment");
		const reason = shouldFilter(item);
		if (reason) {
			item.filter_reason = reason;
			filtered.push(item);
		} else {
			kept.push(item);
		}
	}

	// Sort kept items chronologically (newest first)
	kept.sort((a, b) => b.created_utc - a.created_utc);

	return { kept, filtered };
}
