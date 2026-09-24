import { runtimeConfig } from "./config.ts";

export interface FirecrawlSearchResult {
	query: string;
	title: string;
	url: string;
	description: string;
	markdown?: string;
}

function endpoint(path: string): string {
	const base = runtimeConfig.firecrawl.apiUrl.replace(/\/$/, "");
	return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function isHostedFirecrawl(url: string): boolean {
	try {
		return /(^|\.)firecrawl\.dev$/i.test(new URL(url).hostname);
	} catch {
		return true;
	}
}

/** True when our Firecrawl client can make requests without guaranteed auth failures. */
export function isFirecrawlConfigured(): boolean {
	const { apiKey, apiUrl } = runtimeConfig.firecrawl;
	return Boolean(apiKey || !isHostedFirecrawl(apiUrl));
}

function authHeaders(): Record<string, string> {
	const { apiKey, apiUrl } = runtimeConfig.firecrawl;
	if (!apiKey && isHostedFirecrawl(apiUrl)) {
		throw new Error("FIRECRAWL_API_KEY is required for api.firecrawl.dev; set it or point FIRECRAWL_API_URL at a self-hosted Firecrawl instance.");
	}
	return {
		"Content-Type": "application/json",
		...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
	};
}

const SEARCH_TIMEOUT_MS = 30_000;
const SCRAPE_TIMEOUT_MS = 60_000;

/**
 * fetch with a hard timeout + one retry. A hung Firecrawl instance (or a slow
 * page render) must never stall a whole sweep — before this guard, an
 * unreachable instance froze the pipeline indefinitely.
 */
async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	retries = 1,
): Promise<Response> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await fetch(url, { ...init, signal: controller.signal });
		} catch (err) {
			lastErr = err;
			if (attempt < retries) await new Promise((r) => setTimeout(r, 1500));
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastErr;
}

export async function searchWeb(query: string, opts: { limit?: number } = {}): Promise<FirecrawlSearchResult[]> {
	const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
	const response = await fetchWithTimeout(endpoint("/search"), {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			query,
			limit,
			scrapeOptions: {
				formats: ["markdown"],
				onlyMainContent: true,
			},
		}),
	}, SEARCH_TIMEOUT_MS);

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Firecrawl search failed (${response.status}): ${body.slice(0, 300)}`);
	}

	const payload = await response.json() as any;
	// Response shapes vary across Firecrawl versions/deployments:
	//   hosted v2:   { data: [ ... ] }                      (data is the array)
	//   self-hosted: { data: { web: [ ... ] } }            (data.web is the array)
	//   legacy:      { results: [ ... ] }
	const rows = Array.isArray(payload.data)
		? payload.data
		: Array.isArray(payload.data?.web)
			? payload.data.web
			: Array.isArray(payload.results)
				? payload.results
				: [];
	return rows.map((row: any) => ({
		query,
		title: String(row.title ?? row.metadata?.title ?? "Untitled"),
		url: String(row.url ?? row.sourceURL ?? ""),
		description: String(row.description ?? row.snippet ?? row.metadata?.description ?? ""),
		markdown: typeof row.markdown === "string" ? row.markdown : undefined,
	})).filter((row: FirecrawlSearchResult) => row.url);
}

export interface ScrapeResult {
	url: string;
	title: string;
	description: string;
	markdown: string;
	/** All hrefs on the page (only when opts.links is set). Includes mailto:.
	 * The single richest leak channel on profile pages — bios render links as
	 * icons, so they never appear in the markdown text. */
	links?: string[];
}

/**
 * Scrape one URL via Firecrawl.
 *
 * opts.onlyMainContent: Firecrawl's main-content extraction DROPS the header /
 * sidebar / aside where profile pages keep the gold (GitHub bio, location,
 * org, blog link; X profile card). The identity sweep should pass false for
 * profile URLs; the generic web_scrape tool keeps the default (true).
 * opts.links: also request the page's href list (mailto: included).
 */
export async function scrapeUrl(
	url: string,
	opts: { onlyMainContent?: boolean; links?: boolean } = {},
): Promise<ScrapeResult> {
	const response = await fetchWithTimeout(endpoint("/scrape"), {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			url,
			formats: opts.links ? ["markdown", "links"] : ["markdown"],
			onlyMainContent: opts.onlyMainContent ?? true,
		}),
	}, SCRAPE_TIMEOUT_MS);

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Firecrawl scrape failed (${response.status}): ${body.slice(0, 300)}`);
	}

	const payload = await response.json() as any;
	const data = payload.data ?? payload;
	const links: unknown = data.links;
	return {
		url,
		title: String(data.metadata?.title ?? data.title ?? ""),
		description: String(data.metadata?.description ?? data.description ?? ""),
		markdown: String(data.markdown ?? ""),
		links: opts.links && Array.isArray(links)
			? [...new Set(links.map((l) => String(l)).filter(Boolean))]
			: undefined,
	};
}
