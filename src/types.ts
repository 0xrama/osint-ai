/**
 * Shared type definitions for the OSINT AI tool.
 *
 * Reddit post/comment shapes live in `./reddit/fetch.ts` (they are tied to the
 * fetcher). This module holds cross-cutting types used by filtering and analysis.
 */

/**
 * An optional candidate real-world identity hypothesis to verify against the
 * Reddit evidence. The agent treats it as something to confirm or refute —
 * never as given truth — and de-anonymizes independently regardless.
 */
export interface Candidate {
	name?: string;
}

/**
 * A normalized, filterable Reddit item (post or comment).
 * Produced by the heuristic filter and consumed by the deep-analysis pipeline.
 */
export interface FilteredItem {
	id: string;
	type: "post" | "comment";
	subreddit: string;
	author?: string;
	created_utc: number;
	body: string;
	title?: string; // posts only
	is_deleted: boolean;
	is_removed: boolean;
	score: number;
	permalink?: string;
	url?: string;
	source?: string;
	filter_reason?: string;
}
