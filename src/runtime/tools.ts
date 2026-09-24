import {
	fetchUser,
	fetchUserDeep,
	enrichWithThreadContext,
	formatForLLM,
	type DeepFetchResult,
} from "../reddit/fetch.ts";
import { searchWeb, scrapeUrl } from "./firecrawl.ts";
import { followWebsite } from "../analysis/site-follower.ts";
import type { ToolDefinition } from "./types.ts";

const fetchCache = new Map<string, DeepFetchResult>();

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

/** Web-only tools (web_search + web_scrape). Shared by the live agent and
 * the deep-analysis synthesis agent so the synthesis step can hunt for the
 * account's cross-platform identities on its own.
 */
export function buildWebTools(): ToolDefinition[] {
	return [
		{
			name: "web_search",
			description: "Search the public web with Firecrawl to find and verify cross-platform identities for a Reddit account. Use targeted queries and cite URLs. Do not treat a matching username alone as identity confirmation — corroborate with other markers.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "Search query" },
					limit: { type: "number", description: "Number of results, 1-10" },
				},
				required: ["query"],
			},
			execute: async (params: { query: string; limit?: number }) => {
				const results = await searchWeb(params.query, { limit: clamp(params.limit ?? 5, 1, 10) });
				return {
					results: results.map((result) => ({
						title: result.title,
						url: result.url,
						description: result.description,
						markdown_preview: result.markdown?.slice(0, 1800),
					})),
				};
			},
		},
		{
			name: "web_scrape",
			description: "Scrape a specific URL with Firecrawl to read a profile or page and corroborate a cross-platform identity.",
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "URL to scrape" },
				},
				required: ["url"],
			},
			execute: async (params: { url: string }) => {
				const result = await scrapeUrl(params.url);
				return { ...result, markdown: result.markdown.slice(0, 6000) };
			},
		},
		{
			name: "web_follow_site",
			description: "Follow a personal website, blog, or portfolio URL: fetches the root page plus up to 5 same-origin identity-shaped sub-pages (/about, /cv, /resume, /contact, /bio, /portfolio) and preserves mailto: and http(s) link hrefs before stripping HTML. Prefer this over web_scrape for personal sites/portfolios because it auto-expands identity sub-pages and captures contact emails hidden in <a href>.",
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "Personal site / portfolio / blog URL to follow" },
				},
				required: ["url"],
			},
			execute: async (params: { url: string }) => {
				const site = await followWebsite(params.url);
				if (!site) return { url: params.url, text: "", note: "No text content reachable (non-HTML, blocked, or empty)." };
				return { url: site.url, text: site.text.slice(0, 8000) };
			},
		},
	];
}

export function buildRuntimeTools(options: {
	deepDefault: boolean;
	yearsDefault: number;
	log?: (message: string) => void;
	enableWeb?: boolean;
}): ToolDefinition[] {
	const log = options.log ?? (() => {});
	const tools: ToolDefinition[] = [
		{
			name: "reddit_search",
			description: "Fetch Reddit posts and comments for a Reddit account to extract identity-relevant signals. Supports deep historical scanning and thread context for sarcasm/irony detection.",
			parameters: {
				type: "object",
				properties: {
					username: { type: "string", description: "Reddit username without u/ prefix" },
					deep: { type: "boolean", description: "Use deep historical scanning" },
					years: { type: "number", description: "Years to scan back" },
				},
				required: ["username"],
			},
			execute: async (params: { username: string; deep?: boolean; years?: number }) => {
				const deep = params.deep ?? options.deepDefault;
				const years = params.years ?? (deep ? options.yearsDefault : 2);
				const key = `${params.username}:${deep}:${years}`;
				let result = fetchCache.get(key);
				if (!result) {
					log(deep ? `[reddit] Deep scan u/${params.username} (${years} years)` : `[reddit] Fetch u/${params.username}`);
					result = deep
						? await fetchUserDeep(params.username, years, (current, total, label) => log(`[reddit] ${label} (${current}/${total})`))
						: await fetchUser(params.username);
					fetchCache.set(key, result);
				} else {
					log(`[reddit] Reusing cached fetch for u/${params.username}`);
				}

				log(`[reddit] Enriching thread context...`);
				const enriched = await enrichWithThreadContext(result, 100);
				return {
					text: formatForLLM(result, {
						maxItems: 220,
						includeThreadContext: true,
						contextualizedPosts: enriched.posts,
						contextualizedComments: enriched.comments,
					}),
					stats: result.stats,
					years_covered: result.years_covered,
					date_range: {
						earliest: new Date(result.date_range.earliest * 1000).toISOString(),
						latest: new Date(result.date_range.latest * 1000).toISOString(),
					},
				};
			},
		},
		{
			name: "reddit_search_deleted",
			description: "Fetch only deleted/removed Reddit posts and comments. Deleted content is often the most revealing for identity resolution — prioritize it.",
			parameters: {
				type: "object",
				properties: {
					username: { type: "string", description: "Reddit username without u/ prefix" },
					deep: { type: "boolean", description: "Use deep historical scanning" },
					years: { type: "number", description: "Years to scan back" },
				},
				required: ["username"],
			},
			execute: async (params: { username: string; deep?: boolean; years?: number }) => {
				const deep = params.deep ?? options.deepDefault;
				const years = params.years ?? (deep ? options.yearsDefault : 2);
				const result = deep ? await fetchUserDeep(params.username, years) : await fetchUser(params.username);
				const enriched = await enrichWithThreadContext(result, 50);
				const deletedPosts = enriched.posts.filter((p) => p.is_deleted || p.is_removed);
				const deletedComments = enriched.comments.filter((c) => c.is_deleted || c.is_removed);
				const lines: string[] = [];
				lines.push(`Deleted/removed content for u/${params.username}: ${deletedPosts.length} posts, ${deletedComments.length} comments`);
				for (const p of deletedPosts.slice(0, 80)) {
					const date = new Date(p.created_utc * 1000).toISOString().slice(0, 10);
					lines.push(`[${date}] r/${p.subreddit} POST ${p.title}`);
					if (p.selftext && !["[deleted]", "[removed]"].includes(p.selftext)) lines.push(`  ${p.selftext.slice(0, 1000)}`);
				}
				for (const c of deletedComments.slice(0, 120)) {
					const date = new Date(c.created_utc * 1000).toISOString().slice(0, 10);
					lines.push(`[${date}] r/${c.subreddit} COMMENT ${c.body.slice(0, 700)}`);
				}
				return { text: lines.join("\n"), deletedPosts: deletedPosts.length, deletedComments: deletedComments.length };
			},
		},
	];

	if (options.enableWeb) {
		tools.push(...buildWebTools());
	}

	return tools;
}
