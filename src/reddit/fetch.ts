/**
 * Reddit archive fetcher — pulls posts + comments from Arctic Shift, PullPush,
 * and Reddit's own API. Supports deep historical scanning (5-7+ years) and
 * thread context retrieval for situational awareness (sarcasm/irony detection).
 *
 * Deep scan strategy:
 *   Queries are split into monthly time windows going back N years.
 *   Each month is fetched independently with full pagination, bypassing the
 *   per-query item limits that normally cap at ~1000-5000 items.
 *
 * Context awareness strategy:
 *   For each comment/post, we fetch the parent thread from old.reddit.com's
 *   JSON API, providing: thread title, OP selftext, parent comment chain.
 *   This lets the LLM detect sarcasm, irony, memes, and roleplay.
 */

const ARCTIC_SHIFT = "https://arctic-shift.photon-reddit.com/api";
const PULLPUSH = "https://api.pullpush.io/reddit/search";
const REDDIT_JSON = "https://www.reddit.com";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RedditPost {
	id: string;
	title: string;
	selftext: string;
	author: string;
	subreddit: string;
	created_utc: number;
	score: number;
	num_comments: number;
	url: string;
	permalink: string;
	is_deleted: boolean;
	is_removed: boolean;
	source: string;
}

export interface RedditComment {
	id: string;
	body: string;
	author: string;
	subreddit: string;
	created_utc: number;
	score: number;
	permalink: string;
	link_id: string;
	is_deleted: boolean;
	is_removed: boolean;
	source: string;
}

export interface ThreadContext {
	/** The submission this item belongs to */
	post_title: string;
	post_selftext: string;
	post_author: string;
	post_subreddit: string;
	post_created_utc: number;
	post_url: string;
	/** Parent comment chain (empty for top-level) */
	parent_comments: { author: string; body: string; depth: number }[];
	/** Whether this is a meme/satire/shitpost subreddit */
	is_meme_subreddit: boolean;
	/** The subreddit's description/sidebar (if available) */
	subreddit_description: string;
}

export interface ContextualizedComment extends RedditComment {
	thread_context: ThreadContext | null;
}

export interface ContextualizedPost extends RedditPost {
	thread_context: ThreadContext | null;
}

export interface DeepFetchResult {
	posts: RedditPost[];
	comments: RedditComment[];
	username: string;
	fetched_at: string;
	years_covered: number;
	date_range: { earliest: number; latest: number };
	stats: {
		total_posts: number;
		total_comments: number;
		deleted_posts: number;
		deleted_comments: number;
		removed_posts: number;
		removed_comments: number;
	};
}

// ── Known meme/satire/shitpost subreddits — helps detect irony ──────────

const MEME_SUBREDDITS = new Set([
	"memes", "dankmemes", "me_irl", "meirl", "2meirl4meirl",
	"shitposting", "shitpost", "cirkeltrek", "okbuddyretard",
	"okbuddy", "bonehurtingjuice", "comedyheaven", "comedycemetery",
	"copypasta", "greentext", "tumblr", "twitter", "facepalm",
	"atetheonion", "woooosh", "whoosh", "sarcasm", "irony",
	"nottheonion", "theonion", "onionheadlines",
	"indianpeoplefacebook", "indianpeoplequora",
	"2bharat4you", "indianworkcirclejerk",
	"programmerhumor", "programminghumor",
	"wallstreetbets", "wsb", "wallstreetbetsnew",
	"gamingcirclejerk", "moviecirclejerk",
	"animecirclejerk", "characterrant",
	"fuckcars", "fuckcarscirclejerk",
	"europe", "europeancirclejerk",
	"politicalcompassmemes", "polcompball",
	"libertarianmeme", "conservative",
	"pics", "interestingasfuck", "mildlyinteresting",
	"mildlyinfuriating", "oddlysatisfying",
	"cursedcomments", "blursedimages",
	"technicallythetruth", "technicallycorrect",
	"fakehistoryporn", "fakereddits",
	"subsimulatorgpt2",
]);

/** Subreddits where content is typically ironic/satirical */
const SATIRE_SUBREDDITS = new Set([
	"2bharat4you", "indianworkcirclejerk",
	"gamingcirclejerk", "moviecirclejerk",
	"animecirclejerk", "characterrant",
	"lewronggeneration", "im14andthisisdeep",
	"delusionalartists", "choosingbeggars",
	"amitheangel", "amithedevil",
	"thatHappened", "nothingeverhappens",
	"quityourbullshit",
]);

function isMemeSubreddit(sub: string): boolean {
	const lower = sub.toLowerCase();
	return MEME_SUBREDDITS.has(lower) || SATIRE_SUBREDDITS.has(lower);
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function fetchJSON(url: string, retries = 2, timeoutMs = 30_000): Promise<any> {
	let rateLimitRetries = 0;
	const maxRateLimitRetries = 3;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(url, {
				headers: { "User-Agent": "osint-ai/1.0 (by u/osint-ai-bot)" },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (res.status === 429) {
				rateLimitRetries++;
				if (rateLimitRetries > maxRateLimitRetries) {
					console.error(`[rate-limit] Too many 429s (${rateLimitRetries}), giving up`);
					throw new Error(`Rate limited repeatedly on ${url}`);
				}
				const wait = (parseInt(res.headers.get("retry-after") || "30") + Math.random() * 5) * 1000;
				console.error(`[rate-limit] Waiting ${Math.round(wait)}ms (attempt ${rateLimitRetries}/${maxRateLimitRetries})...`);
				await new Promise((r) => setTimeout(r, wait));
				attempt--; // don't burn a regular retry on rate limits
				continue;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
			return await res.json();
		} catch (err) {
			if (attempt === retries) throw err;
			const delay = Math.round(2000 * Math.pow(2, attempt) * (0.8 + Math.random() * 0.4));
			console.error(`[retry] ${(err as Error).message} — retrying in ${delay}ms`);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

/** Fetch with a timeout wrapper */
async function fetchWithTimeout(url: string, timeoutMs = 20_000): Promise<any> {
	return fetchJSON(url, 2, timeoutMs);
}

/** Safe wrapper that returns fallback on failure */
async function safeFetch<T>(
	label: string,
	fn: () => Promise<T[]>,
	timeoutMs = 60_000,
): Promise<T[]> {
	try {
		const result = await Promise.race([
			fn(),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
			),
		]);
		return result;
	} catch (err: any) {
		console.error(`[fetch] ${label} skipped: ${err.message}`);
		return [];
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isDeleted(text: string): boolean {
	return text === "[deleted]" || text === "[removed]";
}

function isRemoved(text: string): boolean {
	return text === "[removed]";
}

function normalizePost(raw: any, source: string): RedditPost {
	const selftext = raw.selftext ?? "";
	return {
		id: raw.id,
		title: raw.title ?? "",
		selftext,
		author: raw.author ?? "",
		subreddit: raw.subreddit ?? "",
		created_utc: raw.created_utc ?? 0,
		score: raw.score ?? 0,
		num_comments: raw.num_comments ?? 0,
		url: raw.url ?? "",
		permalink: raw.permalink ?? "",
		is_deleted: isDeleted(selftext) || isDeleted(raw.author),
		is_removed: isRemoved(selftext),
		source,
	};
}

function normalizeComment(raw: any, source: string): RedditComment {
	const body = raw.body ?? "";
	return {
		id: raw.id,
		body,
		author: raw.author ?? "",
		subreddit: raw.subreddit ?? "",
		created_utc: raw.created_utc ?? 0,
		score: raw.score ?? 0,
		permalink: raw.permalink ?? "",
		link_id: raw.link_id ?? "",
		is_deleted: isDeleted(body) || isDeleted(raw.author),
		is_removed: isRemoved(body),
		source,
	};
}

function dedupPosts(all: RedditPost[]): RedditPost[] {
	const map = new Map<string, RedditPost>();
	for (const p of all) {
		const existing = map.get(p.id);
		if (!existing) {
			map.set(p.id, p);
		} else if (p.selftext.length > existing.selftext.length) {
			map.set(p.id, p);
		}
	}
	return [...map.values()].sort((a, b) => b.created_utc - a.created_utc);
}

function dedupComments(all: RedditComment[]): RedditComment[] {
	const map = new Map<string, RedditComment>();
	for (const c of all) {
		const existing = map.get(c.id);
		if (!existing) {
			map.set(c.id, c);
		} else if (c.body.length > existing.body.length) {
			map.set(c.id, c);
		}
	}
	return [...map.values()].sort((a, b) => b.created_utc - a.created_utc);
}

// ── Time-based date generation for deep scanning ──────────────────────────

/** Generate monthly time windows going back `years` years from now */
function generateMonthlyWindows(years: number): { start: number; end: number }[] {
	const now = Date.now();
	const windows: { start: number; end: number }[] = [];
	const endDate = new Date(now);

	// Generate months going back `years` years
	const startDate = new Date(now);
	startDate.setFullYear(startDate.getFullYear() - years);

	// Walk back to the start of the start month
	startDate.setDate(1);
	startDate.setHours(0, 0, 0, 0);

	// Walk forward month by month
	const current = new Date(startDate);
	while (current < endDate) {
		const monthStart = new Date(current);

		// Next month
		current.setMonth(current.getMonth() + 1);
		const monthEnd = current < endDate ? new Date(current) : new Date(endDate);

		windows.push({
			start: Math.floor(monthStart.getTime() / 1000),
			end: Math.floor(monthEnd.getTime() / 1000),
		});

		// Safety: don't create more than ~120 months (10 years)
		if (windows.length > 120) break;
	}

	return windows;
}

/** Generate yearly time windows (more efficient, use for production) */
function generateYearlyWindows(years: number): { start: number; end: number }[] {
	const now = Date.now();
	const windows: { start: number; end: number }[] = [];

	const startDate = new Date(now);
	startDate.setFullYear(startDate.getFullYear() - years);
	startDate.setMonth(0, 1);
	startDate.setHours(0, 0, 0, 0);

	const endDate = new Date(now);

	const current = new Date(startDate);
	while (current < endDate) {
		const yearStart = new Date(current);
		current.setFullYear(current.getFullYear() + 1);
		const yearEnd = current < endDate ? new Date(current) : new Date(endDate);

		windows.push({
			start: Math.floor(yearStart.getTime() / 1000),
			end: Math.floor(yearEnd.getTime() / 1000),
		});
	}

	return windows;
}

// ── Arctic Shift fetching with time windows ───────────────────────────────

async function fetchAllArcticInWindow(
	type: "posts" | "comments",
	username: string,
	windowStart: number,
	windowEnd: number,
	limit = 100,
): Promise<any[]> {
	const results: any[] = [];
	let lastSeen: string | undefined;
	let page = 0;
	const maxPages = 20; // limit pages per window to avoid hammering

	while (true) {
		let url = `${ARCTIC_SHIFT}/${type}/search?author=${encodeURIComponent(username)}&limit=${limit}&sort=desc`;
		// Use cursor as after when paginating, otherwise use the window start
		const after = lastSeen
			? Math.max(windowStart, parseInt(lastSeen))
			: windowStart;
		url += `&after=${after}`;
		url += `&before=${windowEnd}`;

		let data: any;
		try {
			data = await fetchWithTimeout(url, 20_000);
		} catch {
			break; // timeout or error, move to next window
		}

		const items = data?.data ?? [];
		if (items.length === 0) break;

		results.push(...items);

		if (items.length < limit) break;
		lastSeen = items[items.length - 1]?.created_utc?.toString();
		page++;
		if (page >= maxPages) {
			console.error(
				`[fetch] Arctic Shift ${type} window ${new Date(windowStart * 1000).toISOString().slice(0, 10)} ` +
				`hit ${maxPages} pages; data may be partial for active accounts.`,
			);
			break;
		}
	}

	return results;
}

async function fetchAllArcticDeep(
	type: "posts" | "comments",
	username: string,
	windows: { start: number; end: number }[],
	onProgress?: (current: number, total: number, window: string) => void,
): Promise<any[]> {
	const allResults: any[][] = [];

	for (let i = 0; i < windows.length; i++) {
		const w = windows[i];
		const label = `${type} ${new Date(w.start * 1000).toISOString().slice(0, 7)}`;
		onProgress?.(i + 1, windows.length, label);

		const results = await safeFetch(
			`AS ${label}`,
			() => fetchAllArcticInWindow(type, username, w.start, w.end),
			45_000,
		);
		if (results.length > 0) {
			allResults.push(results);
		}

		// Respectful delay between windows
		if (i < windows.length - 1) {
			await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));
		}
	}

	return allResults.flat();
}

// ── PullPush fetching with time windows ───────────────────────────────────

async function fetchAllPullpushInWindow(
	type: "submission" | "comment",
	username: string,
	windowStart: number,
	windowEnd: number,
	limit = 100,
): Promise<any[]> {
	const results: any[] = [];
	let lastSeen: string | undefined;
	let page = 0;
	const maxPages = 10; // PullPush is fragile — be very gentle

	while (true) {
		let url = `${PULLPUSH}/${type}/?author=${encodeURIComponent(username)}&limit=${limit}&sort=desc`;
		url += `&after=${windowStart}`;
		// Use cursor as before when paginating, otherwise use the window end
		const before = lastSeen ? Math.min(windowEnd, parseInt(lastSeen)) : windowEnd;
		url += `&before=${before}`;

		let data: any;
		try {
			data = await fetchWithTimeout(url, 20_000);
		} catch {
			break;
		}

		const items = data?.data ?? [];
		if (items.length === 0) break;

		results.push(...items);

		if (items.length < limit) break;
		lastSeen = items[items.length - 1]?.created_utc?.toString();
		page++;
		if (page >= maxPages) {
			console.error(
				`[fetch] PullPush ${type} window ${new Date(windowStart * 1000).toISOString().slice(0, 10)} ` +
				`hit ${maxPages} pages; data may be partial for active accounts.`,
			);
			break;
		}
	}

	return results;
}

async function fetchAllPullpushDeep(
	type: "submission" | "comment",
	username: string,
	windows: { start: number; end: number }[],
	onProgress?: (current: number, total: number, window: string) => void,
): Promise<any[]> {
	const allResults: any[][] = [];

	for (let i = 0; i < windows.length; i++) {
		const w = windows[i];
		const label = `${type} ${new Date(w.start * 1000).toISOString().slice(0, 7)}`;
		onProgress?.(i + 1, windows.length, label);

		const results = await safeFetch(
			`PP ${label}`,
			() => fetchAllPullpushInWindow(type, username, w.start, w.end),
			45_000,
		);
		if (results.length > 0) {
			allResults.push(results);
		}

		if (i < windows.length - 1) {
			await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
		}
	}

	return allResults.flat();
}

// ── Reddit's own API (fallback for deep historical data) ──────────────────

async function fetchAllRedditAPI(
	type: "submitted" | "comments",
	username: string,
): Promise<any[]> {
	const results: any[] = [];
	let after: string | undefined;
	let page = 0;
	const maxPages = 100; // Reddit limits to 1000 items, so 10 pages of 100

	while (true) {
		let url = `${REDDIT_JSON}/user/${encodeURIComponent(username)}/${type}.json?limit=100&raw_json=1`;
		if (after) url += `&after=${after}`;

		let data: any;
		try {
			data = await fetchWithTimeout(url, 15_000);
		} catch {
			break;
		}

		const children = data?.data?.children ?? [];
		if (children.length === 0) break;

		const items = children
			.filter((c: any) => c.kind === "t3" || c.kind === "t1")
			.map((c: any) => c.data);

		results.push(...items);

		after = data.data.after;
		page++;
		if (!after || page > maxPages) break;

		// Be gentle to Reddit's API
		await new Promise((r) => setTimeout(r, 1500));
	}

	return results;
}

// ── Thread context fetching (situational awareness) ──────────────────────

/**
 * Fetches the full thread context for a Reddit item using old.reddit.com's JSON API.
 * Returns the thread title, OP text, parent comment chain, and subreddit metadata.
 * This is CRITICAL for detecting sarcasm, irony, and memes.
 */
export async function fetchThreadContext(
	permalink: string | undefined,
	subreddit: string,
	link_id?: string,
): Promise<ThreadContext | null> {
	if (!permalink && !link_id) return null;

	// Extract thread ID from link_id (e.g., "t3_abc123" -> "abc123")
	let threadId: string | undefined;
	if (link_id) {
		threadId = link_id.replace(/^t[0-9]_/, "");
	} else if (permalink) {
		const parts = permalink.split("/");
		// Reddit permalink: /r/subreddit/comments/thread_id/title/comment_id/
		const commentIndex = parts.indexOf("comments");
		if (commentIndex !== -1 && parts.length > commentIndex + 1) {
			threadId = parts[commentIndex + 1];
		}
	}

	if (!threadId) return null;

	// Fetch thread from old.reddit.com JSON
	const url = `https://old.reddit.com/r/${encodeURIComponent(subreddit)}/comments/${threadId}/_.json?raw_json=1&limit=10`;

	let data: any[];
	try {
		data = await fetchWithTimeout(url, 15_000);
	} catch {
		return null;
	}

	if (!Array.isArray(data) || data.length < 2) return null;

	// First element: submission listing
	const submissionListing = data[0];
	const submissionChildren = submissionListing?.data?.children ?? [];
	const postData = submissionChildren[0]?.data;

	if (!postData) return null;

	// Second element: comments listing
	const commentsListing = data[1];
	const commentChildren = commentsListing?.data?.children ?? [];

	// Build parent comment chain (follow the first top-level comment's replies)
	const parentComments: { author: string; body: string; depth: number }[] = [];
	function extractComments(children: any[], depth = 0) {
		for (const child of children) {
			if (child.kind === "t1") {
				const cd = child.data;
				const body = (cd.body ?? "").slice(0, 500);
				if (body && body !== "[deleted]" && body !== "[removed]") {
					parentComments.push({
						author: cd.author ?? "[deleted]",
						body,
						depth,
					});
				}
				if (cd.replies && cd.replies.data?.children) {
					extractComments(cd.replies.data.children, depth + 1);
				}
			}
			if (parentComments.length >= 20) break; // limit context
		}
	}
	extractComments(commentChildren);

	return {
		post_title: postData.title ?? "",
		post_selftext: (postData.selftext ?? "").slice(0, 2000),
		post_author: postData.author ?? "[deleted]",
		post_subreddit: postData.subreddit ?? subreddit,
		post_created_utc: postData.created_utc ?? 0,
		post_url: postData.url ?? "",
		parent_comments: parentComments,
		is_meme_subreddit: isMemeSubreddit(subreddit),
		subreddit_description: postData.subreddit_subscribers
			? `Subscribers: ${postData.subreddit_subscribers?.toLocaleString() ?? "?"}`
			: "",
	};
}

/** Format thread context into a readable block */
export function formatThreadContext(ctx: ThreadContext | null): string {
	if (!ctx) return "";

	const parts: string[] = [];
	parts.push(`[THREAD CONTEXT]`);
	parts.push(`Subreddit: r/${ctx.post_subreddit}${ctx.is_meme_subreddit ? " ⚠️ MEME/SATIRE SUBREDDIT — content may be ironic" : ""}`);
	parts.push(`Thread: "${ctx.post_title}"`);
	if (ctx.post_selftext) {
		const snippet = ctx.post_selftext.length > 500 ? ctx.post_selftext.slice(0, 500) + "..." : ctx.post_selftext;
		parts.push(`OP text: ${snippet}`);
	}

	if (ctx.parent_comments.length > 0) {
		parts.push(`Thread comments (for context):`);
		for (const pc of ctx.parent_comments.slice(0, 8)) {
			const indent = "  ".repeat(Math.min(pc.depth, 3));
			parts.push(`${indent}u/${pc.author}: ${pc.body.slice(0, 200)}`);
		}
	}

	if (ctx.subreddit_description) {
		parts.push(`Subreddit info: ${ctx.subreddit_description}`);
	}

	return parts.join("\n");
}

// ── Main fetch functions ─────────────────────────────────────────────────

/** Standard fetch — limited to ~2 years of history for API-friendliness */
export async function fetchUser(username: string, years = 2): Promise<DeepFetchResult> {
	console.error(`[fetch] Fetching u/${username} (standard mode, last ${years} years)...`);

	// Only look back `years` years to avoid hammering the API
	const cutoffSec = Math.floor((Date.now() - years * 365.25 * 24 * 60 * 60 * 1000) / 1000);
	const nowSec = Math.floor(Date.now() / 1000) + 86400;

	const [arcticPosts, arcticComments, ppPosts, ppComments] = await Promise.all([
		safeFetch("Arctic Shift posts", () => fetchAllArcticInWindow("posts", username, cutoffSec, nowSec)),
		safeFetch("Arctic Shift comments", () => fetchAllArcticInWindow("comments", username, cutoffSec, nowSec)),
		safeFetch("PullPush posts", () => fetchAllPullpushInWindow("submission", username, cutoffSec, nowSec)),
		safeFetch("PullPush comments", () => fetchAllPullpushInWindow("comment", username, cutoffSec, nowSec)),
	]);

	const allPosts = dedupPosts([
		...arcticPosts.map((r) => normalizePost(r, "arctic-shift")),
		...ppPosts.map((r) => normalizePost(r, "pullpush")),
	]);

	const allComments = dedupComments([
		...arcticComments.map((r) => normalizeComment(r, "arctic-shift")),
		...ppComments.map((r) => normalizeComment(r, "pullpush")),
	]);

	return buildResult(username, allPosts, allComments, years);
}

/**
 * Deep scan — fetches 5-7+ years of data by iterating through yearly/monthly
 * time windows. This bypasses API per-query item limits.
 *
 * @param years How many years to go back (default: 7)
 * @param onProgress Called with (current, total, label) for progress reporting
 */
export async function fetchUserDeep(
	username: string,
	years = 7,
	onProgress?: (current: number, total: number, label: string) => void,
): Promise<DeepFetchResult> {
	console.error(`[deep-scan] Deep scanning u/${username} — going back ${years} years...`);

	const windows = generateYearlyWindows(years);
	console.error(`[deep-scan] Generated ${windows.length} yearly windows: ${windows[0].start} to ${windows[windows.length-1].end}`);

	// Use monthly windows for more granular data (comment-heavy users benefit)
	// but yearly is faster for most cases
	const useMonthly = years <= 3; // Only use monthly for short ranges
	const timeWindows = useMonthly ? generateMonthlyWindows(years) : windows;

	const totalWindows = 4; // AS posts + AS comments + PP posts + PP comments
	let completed = 0;

	const progress = (current: number, total: number, label: string) => {
		const overallProgress = Math.floor((completed / totalWindows) * 100);
		onProgress?.(current, total, `[${overallProgress}%] ${label}`);
	};

	const [arcticPosts, arcticComments, ppPosts, ppComments] = await Promise.all([
		safeFetch("Arctic Shift posts (deep)", () => {
			completed++;
			return fetchAllArcticDeep("posts", username, timeWindows, (c, t, l) => progress(c, t, `AS posts ${l}`));
		}),
		safeFetch("Arctic Shift comments (deep)", () => {
			completed++;
			return fetchAllArcticDeep("comments", username, timeWindows, (c, t, l) => progress(c, t, `AS comments ${l}`));
		}),
		safeFetch("PullPush posts (deep)", () => {
			completed++;
			return fetchAllPullpushDeep("submission", username, timeWindows, (c, t, l) => progress(c, t, `PP posts ${l}`));
		}),
		safeFetch("PullPush comments (deep)", () => {
			completed++;
			return fetchAllPullpushDeep("comment", username, timeWindows, (c, t, l) => progress(c, t, `PP comments ${l}`));
		}),
	]);

	let allPosts = dedupPosts([
		...arcticPosts.map((r) => normalizePost(r, "arctic-shift")),
		...ppPosts.map((r) => normalizePost(r, "pullpush")),
	]);

	let allComments = dedupComments([
		...arcticComments.map((r) => normalizeComment(r, "arctic-shift")),
		...ppComments.map((r) => normalizeComment(r, "pullpush")),
	]);

	// If either archive side returned very little, try Reddit's own API for that side.
	const sparsePosts = allPosts.length < 50;
	const sparseComments = allComments.length < 50;
	if (sparsePosts || sparseComments) {
		const cutoffSec = Math.floor((Date.now() - years * 365.25 * 24 * 60 * 60 * 1000) / 1000);
		console.error(
			`[deep-scan] Archive data sparse (${allPosts.length} posts, ${allComments.length} comments), ` +
			`falling back to Reddit API for ${[sparsePosts ? "posts" : null, sparseComments ? "comments" : null].filter(Boolean).join(" and ")}...`,
		);
		const [redditPosts, redditComments] = await Promise.all([
			sparsePosts ? safeFetch("Reddit API posts", () => fetchAllRedditAPI("submitted", username)) : Promise.resolve([]),
			sparseComments ? safeFetch("Reddit API comments", () => fetchAllRedditAPI("comments", username)) : Promise.resolve([]),
		]);

		if (redditPosts.length > 0) {
			allPosts = dedupPosts([
				...allPosts,
				...redditPosts
					.filter((r) => Number(r?.created_utc ?? 0) >= cutoffSec)
					.map((r) => normalizePost(r, "reddit-api")),
			]);
		}
		if (redditComments.length > 0) {
			allComments = dedupComments([
				...allComments,
				...redditComments
					.filter((r) => Number(r?.created_utc ?? 0) >= cutoffSec)
					.map((r) => normalizeComment(r, "reddit-api")),
			]);
		}
	}

	return buildResult(username, allPosts, allComments, years);
}

function buildResult(
	username: string,
	allPosts: RedditPost[],
	allComments: RedditComment[],
	years: number,
): DeepFetchResult {
	const deletedPosts = allPosts.filter((p) => p.is_deleted || p.is_removed);
	const deletedComments = allComments.filter((c) => c.is_deleted || c.is_removed);

	const timestamps = [
		...allPosts.map((p) => p.created_utc),
		...allComments.map((c) => c.created_utc),
	].filter((t) => t > 0);

	const earliest = timestamps.length > 0 ? Math.min(...timestamps) : 0;
	const latest = timestamps.length > 0 ? Math.max(...timestamps) : 0;

	console.error(
		`[fetch] Got ${allPosts.length} posts (${deletedPosts.length} deleted/removed), ` +
		`${allComments.length} comments (${deletedComments.length} deleted/removed) ` +
		`— spanning ${new Date(earliest * 1000).toISOString().slice(0, 10)} to ${new Date(latest * 1000).toISOString().slice(0, 10)}`,
	);

	return {
		posts: allPosts,
		comments: allComments,
		username,
		fetched_at: new Date().toISOString(),
		years_covered: years,
		date_range: { earliest, latest },
		stats: {
			total_posts: allPosts.length,
			total_comments: allComments.length,
			deleted_posts: deletedPosts.length,
			deleted_comments: deletedComments.length,
			removed_posts: allPosts.filter((p) => p.is_removed).length,
			removed_comments: allComments.filter((c) => c.is_removed).length,
		},
	};
}

// ── Context enrichment (thread context for key items) ────────────────────

/**
 * Enrich a FetchResult with thread context for the most important items.
 * This helps the LLM understand context and detect irony/sarcasm.
 */
export async function enrichWithThreadContext(
	result: DeepFetchResult,
	maxItems = 50,
): Promise<{
	posts: ContextualizedPost[];
	comments: ContextualizedComment[];
}> {
	console.error(`[context] Fetching thread context for up to ${maxItems} items...`);

	// Focus on:
	// 1. Deleted posts (most revealing)
	// 2. Recent active comments (most relevant)
	// 3. Posts/items from potentially ironic subreddits

	const priorityItems: { type: "post" | "comment"; item: any; permalink: string; subreddit: string; link_id?: string }[] = [];

	// Add deleted/removed posts first
	for (const p of result.posts) {
		if ((p.is_deleted || p.is_removed) && p.permalink) {
			priorityItems.push({
				type: "post",
				item: p,
				permalink: p.permalink,
				subreddit: p.subreddit,
			});
		}
	}

	// Add items from meme/satire subreddits (high false-positive risk)
	for (const c of result.comments) {
		if (isMemeSubreddit(c.subreddit) && c.permalink) {
			priorityItems.push({
				type: "comment",
				item: c,
				permalink: c.permalink,
				subreddit: c.subreddit,
				link_id: c.link_id,
			});
		}
	}

	// Add remaining items up to maxItems
	const existingIds = new Set(priorityItems.map((pi) => pi.item.id));
	for (const p of result.posts) {
		if (priorityItems.length >= maxItems) break;
		if (!existingIds.has(p.id) && p.permalink) {
			priorityItems.push({
				type: "post",
				item: p,
				permalink: p.permalink,
				subreddit: p.subreddit,
			});
			existingIds.add(p.id);
		}
	}
	for (const c of result.comments) {
		if (priorityItems.length >= maxItems) break;
		if (!existingIds.has(c.id) && c.permalink) {
			priorityItems.push({
				type: "comment",
				item: c,
				permalink: c.permalink,
				subreddit: c.subreddit,
				link_id: c.link_id,
			});
			existingIds.add(c.id);
		}
	}

	// Fetch thread contexts with very conservative concurrency
	const contexts = new Map<string, ThreadContext | null>();
	const concurrency = 2; // be gentle to old.reddit.com
	const chunks: typeof priorityItems[] = [];

	for (let i = 0; i < priorityItems.length; i += concurrency) {
		chunks.push(priorityItems.slice(i, i + concurrency));
	}

	for (const chunk of chunks) {
		const results = await Promise.all(
			chunk.map(async (pi) => {
				const ctx = await fetchThreadContext(pi.permalink, pi.subreddit, pi.link_id);
				return { id: pi.item.id, ctx };
			}),
		);
		for (const r of results) {
			contexts.set(r.id, r.ctx);
		}

		// Generous delay between batches
		if (chunks.indexOf(chunk) < chunks.length - 1) {
			await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1000));
		}
	}

	// Build contextualized items
	const contextualizedPosts: ContextualizedPost[] = result.posts.map((p) => ({
		...p,
		thread_context: contexts.get(p.id) ?? null,
	}));

	const contextualizedComments: ContextualizedComment[] = result.comments.map((c) => ({
		...c,
		thread_context: contexts.get(c.id) ?? null,
	}));

	console.error(`[context] Enriched ${contexts.size} items with thread context`);

	return {
		posts: contextualizedPosts,
		comments: contextualizedComments,
	};
}

// ── Formatting ────────────────────────────────────────────────────────────

/** Format a DeepFetchResult into a text summary for LLM consumption */
export function formatForLLM(
	result: DeepFetchResult,
	options?: {
		maxItems?: number;
		includeThreadContext?: boolean;
		contextualizedPosts?: ContextualizedPost[];
		contextualizedComments?: ContextualizedComment[];
	},
): string {
	const maxItems = options?.maxItems ?? 200;
	const includeThreadContext = options?.includeThreadContext ?? true;
	const ctxPosts = options?.contextualizedPosts;
	const ctxComments = options?.contextualizedComments;

	const lines: string[] = [];

	lines.push(`=== REDDIT PROFILE: u/${result.username} ===`);
	lines.push(`Fetched: ${result.fetched_at}`);
	lines.push(`Data range: ${new Date(result.date_range.earliest * 1000).toISOString().slice(0, 10)} to ${new Date(result.date_range.latest * 1000).toISOString().slice(0, 10)}`);
	lines.push(`Years covered: ~${result.years_covered}`);
	lines.push(
		`Stats: ${result.stats.total_posts} posts, ${result.stats.total_comments} comments`,
	);
	lines.push(
		`Deleted/Removed: ${result.stats.deleted_posts} posts, ${result.stats.deleted_comments} comments`,
	);

	// Subreddit breakdown
	const subs = new Map<string, number>();
	for (const c of result.comments) subs.set(c.subreddit, (subs.get(c.subreddit) ?? 0) + 1);
	for (const p of result.posts) subs.set(p.subreddit, (subs.get(p.subreddit) ?? 0) + 1);
	const topSubs = [...subs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
	lines.push(`\nTop subreddits: ${topSubs.map(([s, n]) => {
		const marker = isMemeSubreddit(s) ? "⚠️" : "";
		return `r/${s}(${n})${marker}`;
	}).join(", ")}`);

	// CRITICAL: Flag subreddits where content is likely ironic/satirical
	const ironicSubs = topSubs.filter(([s]) => isMemeSubreddit(s));
	if (ironicSubs.length > 0) {
		lines.push(`\n⚠️ CONTEXT WARNING: The following subreddits are meme/satire/shitpost communities`);
		lines.push(`   Content from these subs is OFTEN IRONIC, SARCASTIC, or JOKING:`);
		for (const [s, n] of ironicSubs) {
			lines.push(`   - r/${s} (${n} posts/comments) — be skeptical of literal interpretations`);
		}
		lines.push(`   ALWAYS check thread context before taking content from these subs seriously.`);
	}

	// Deleted posts (most interesting for OSINT)
	const deletedPosts = result.posts.filter((p) => p.is_deleted || p.is_removed);
	if (deletedPosts.length > 0) {
		lines.push(`\n--- DELETED/REMOVED POSTS (${deletedPosts.length}) ---`);
		for (const p of deletedPosts.slice(0, 50)) {
			const date = new Date(p.created_utc * 1000).toISOString().split("T")[0];
			const ctx = ctxPosts?.find((cp) => cp.id === p.id)?.thread_context ?? null;
			const ironyFlag = ctx?.is_meme_subreddit ? " [⚠️ MEME SUB] " : "";
			lines.push(`[${date}] r/${p.subreddit}${ironyFlag}| ${p.title}`);
			if (p.selftext && !["[deleted]", "[removed]"].includes(p.selftext)) {
				lines.push(`  Body: ${p.selftext.slice(0, 500)}`);
			}
			if (includeThreadContext && ctx) {
				const ctxStr = formatThreadContext(ctx);
				if (ctxStr) lines.push(`  ${ctxStr.replace(/\n/g, "\n  ")}`);
			}
		}
	}

	// Deleted comments
	const deletedComments = result.comments.filter((c) => c.is_deleted || c.is_removed);
	if (deletedComments.length > 0) {
		lines.push(`\n--- DELETED/REMOVED COMMENTS (${deletedComments.length}) ---`);
		for (const c of deletedComments.slice(0, 80)) {
			const date = new Date(c.created_utc * 1000).toISOString().split("T")[0];
			const ctx = ctxComments?.find((cc) => cc.id === c.id)?.thread_context ?? null;
			const ironyFlag = ctx?.is_meme_subreddit ? " [⚠️ MEME SUB] " : "";
			lines.push(`[${date}] r/${c.subreddit}${ironyFlag}| ${c.body.slice(0, 300)}`);
			if (includeThreadContext && ctx) {
				const ctxStr = formatThreadContext(ctx);
				if (ctxStr) lines.push(`  ${ctxStr.replace(/\n/g, "\n  ")}`);
			}
		}
	}

	// Active posts
	const activePosts = result.posts.filter((p) => !p.is_deleted && !p.is_removed);
	if (activePosts.length > 0) {
		lines.push(`\n--- ACTIVE POSTS (${activePosts.length}) ---`);
		for (const p of activePosts.slice(0, 30)) {
			const date = new Date(p.created_utc * 1000).toISOString().split("T")[0];
			const ctx = ctxPosts?.find((cp) => cp.id === p.id)?.thread_context ?? null;
			const ironyFlag = ctx?.is_meme_subreddit ? " [⚠️ MEME SUB] " : "";
			lines.push(`[${date}] r/${p.subreddit}${ironyFlag}| ${p.title}`);
			if (p.selftext) lines.push(`  Body: ${p.selftext.slice(0, 300)}`);
			if (includeThreadContext && ctx) {
				const ctxStr = formatThreadContext(ctx);
				if (ctxStr) lines.push(`  ${ctxStr.replace(/\n/g, "\n  ")}`);
			}
		}
	}

	// Active comments
	const activeComments = result.comments.filter((c) => !c.is_deleted && !c.is_removed);
	if (activeComments.length > 0) {
		lines.push(`\n--- ACTIVE COMMENTS (${activeComments.length}, showing up to ${maxItems}) ---`);
		for (const c of activeComments.slice(0, maxItems)) {
			const date = new Date(c.created_utc * 1000).toISOString().split("T")[0];
			const ctx = ctxComments?.find((cc) => cc.id === c.id)?.thread_context ?? null;
			const ironyFlag = ctx?.is_meme_subreddit ? " [⚠️ MEME SUB] " : "";
			lines.push(`[${date}] r/${c.subreddit}${ironyFlag}| ${c.body.slice(0, 300)}`);
			if (includeThreadContext && ctx) {
				const ctxStr = formatThreadContext(ctx);
				if (ctxStr) lines.push(`  ${ctxStr.replace(/\n/g, "\n  ")}`);
			}
		}
	}

	// Summary of context hints
	if (includeThreadContext) {
		const totalWithContext = (ctxPosts?.filter((p) => p.thread_context).length ?? 0) +
			(ctxComments?.filter((c) => c.thread_context).length ?? 0);
		lines.push(`\n--- CONTEXT AWARENESS NOTE ---`);
		lines.push(`Thread context was fetched for ${totalWithContext} items to help detect sarcasm/irony.`);
		lines.push(`Items from meme/satire subreddits are marked with ⚠️.`);
		lines.push(`When analyzing: check the thread context block above each item.`);
		lines.push(`If the thread OP or parent comments are clearly sarcastic, the item is likely ironic.`);
		lines.push(`If the subreddit is a circlejerk/shitpost sub, take everything with a grain of salt.`);
	}

	return lines.join("\n");
}
