#!/usr/bin/env bun
/**
 * Reddit archive JSONL downloader & local-data analyzer.
 *
 * Exports a programmatic `downloadUser()` for the TUI pipeline (in-process,
 * non-blocking, with progress callbacks) plus a thin CLI when run directly:
 *
 *   bun run src/reddit/download.ts <username>             # download
 *   bun run src/reddit/download.ts --analyze <username>   # analyze local files
 *   bun run src/reddit/download.ts --subreddit <name>
 *
 * Features:
 *   - Streams data from Arctic Shift first, then falls back to PullPush
 *   - Uses Arctic's limit=auto where available; PullPush uses paged author search
 *   - Splits output into files under max-size
 *   - Resumes interrupted downloads
 *   - Respectful rate limiting
 */

import * as fs from "node:fs/promises";
import * as fsCallback from "node:fs";
import * as path from "node:path";

const ARCTIC = "https://arctic-shift.photon-reddit.com";
const PULLPUSH = "https://api.pullpush.io";
const UA = "osint-ai-downloader/1.0";

type WriteStream = fsCallback.WriteStream;
const createWriteStream = fsCallback.createWriteStream;

// ── Types ──────────────────────────────────────────────────────────────────

interface EntityInfo {
	type: "author" | "subreddit";
	name: string;
	label: string;
}

export interface DownloadUserOptions {
	dir: string;
	maxSizeMB?: number;
	maxTotalMB?: number;
	posts?: boolean;
	comments?: boolean;
	resume?: boolean;
	after?: string;
	before?: string;
}

interface DownloadProgress {
	type: "posts" | "comments";
	itemsDownloaded: number;
	currentFile: string;
	currentFileSize: number;
	totalSize: number;
	currentTimestamp: number;
	isDone: boolean;
}

type DownloadSource = "arctic-shift" | "pullpush";

interface DownloadStreamResult {
	source: DownloadSource;
	itemsDownloaded: number;
	totalSize: number;
	failed: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function fetchJSON(url: string): Promise<any> {
	const res = await fetch(url, {
		headers: { "User-Agent": UA },
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
	}
	return res.json();
}

function toTimestamp(dateStr: string): number {
	if (!dateStr) return 0;
	if (/^\d+$/.test(dateStr)) return parseInt(dateStr) * 1000;
	return new Date(dateStr).getTime();
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

function sourceLabel(source: DownloadSource): string {
	return source === "arctic-shift" ? "Arctic Shift" : "PullPush";
}

// ── Find user / earliest activity ─────────────────────────────────────────

async function resolveEntityInfo(
	name: string,
	type: "author" | "subreddit",
): Promise<{ entity: EntityInfo; earliestMs: number }> {
	const entity: EntityInfo = { type, name, label: type === "author" ? `u/${name}` : `r/${name}` };

	const minUrl = `${ARCTIC}/api/utils/min?${type}=${encodeURIComponent(name)}&meta-app=download-tool`;
	const minData = await fetchJSON(minUrl);

	if (!minData || minData.data === null) {
		throw new Error(`No ${type} found with name "${name}"`);
	}

	const earliestMs = new Date(minData.data).getTime() - 1;

	// NOTE: we intentionally do NOT query /api/{users,subreddits}/search for the
	// per-entity _meta stats (num_posts / num_comments). Those are a periodically
	// recomputed cache snapshot (see post_stats_updated_at / comment_stats_updated_at
	// in the response) and routinely under-count — e.g. it reports "3 posts, 4
	// comments" for accounts where the posts/search + comments/search endpoints
	// actually return 4 and 20. Trusting it printed a misleading "~N available"
	// line that made a correct download look broken. The authoritative count is
	// whatever we actually fetch from the search endpoints below.
	return { entity, earliestMs };
}

async function resolvePullPushEarliest(
	name: string,
	type: "author" | "subreddit",
): Promise<number> {
	const params = `${type}=${encodeURIComponent(name)}&sort=asc&sort_type=created_utc&size=1`;
	const urls = [
		`${PULLPUSH}/reddit/search/submission/?${params}`,
		`${PULLPUSH}/reddit/search/comment/?${params}`,
	];
	const results = await Promise.allSettled(urls.map((url) => fetchJSON(url)));
	const timestamps = results
		.flatMap((result) => result.status === "fulfilled" ? (result.value?.data ?? []) : [])
		.map((item: any) => Number(item?.created_utc ?? 0))
		.filter((ts: number) => ts > 0);
	if (timestamps.length === 0) {
		throw new Error(`No ${type} activity found for "${name}" via PullPush.`);
	}
	return Math.min(...timestamps) * 1000 - 1;
}

async function resolveEntityInfoWithFallback(
	name: string,
	type: "author" | "subreddit",
	onProgress?: (message: string) => void,
): Promise<{ entity: EntityInfo; earliestMs: number }> {
	try {
		return await resolveEntityInfo(name, type);
	} catch (err: any) {
		onProgress?.(`[download] Arctic Shift user lookup failed: ${err?.message ?? err}`);
		onProgress?.(`[download] Trying PullPush lookup for earliest activity...`);
		const entity: EntityInfo = { type, name, label: type === "author" ? `u/${name}` : `r/${name}` };
		const earliestMs = await resolvePullPushEarliest(name, type);
		return { entity, earliestMs };
	}
}

// ── Download stream ──────────────────────────────────────────────────────

async function downloadStream(
	entity: EntityInfo,
	dataType: "posts" | "comments",
	startMs: number,
	endMs: number | null,
	outputDir: string,
	maxFileSize: number,
	maxTotalSize: number,
	resume: boolean,
	onProgress: (p: DownloadProgress) => void,
): Promise<DownloadStreamResult> {
	const prefix = entity.type === "author" ? "u_" : "r_";
	const safeName = entity.name.replace(/[^a-zA-Z0-9_-]/g, "_");
	const baseName = `${prefix}${safeName}_${dataType}`;

	await fs.mkdir(outputDir, { recursive: true }).catch(() => {});

	const existingFiles: string[] = [];
	if (resume) {
		const dir = await fs.readdir(outputDir).catch(() => []);
		for (const f of dir) {
			if (f.startsWith(baseName) && f.endsWith(".jsonl")) existingFiles.push(f);
		}
		existingFiles.sort();
	}

	let currentTimestamp = startMs;
	let currentFileIndex = 0;
	let totalBytes = 0;
	let totalItems = 0;
	let currentFileStream: WriteStream | null = null;
	let currentFilePath = "";
	let currentFileBytes = 0;

	if (resume && existingFiles.length > 0) {
		const lastFile = existingFiles[existingFiles.length - 1];
		const lastFilePath = path.join(outputDir, lastFile);
		const lastFileSize = (await fs.stat(lastFilePath).catch(() => ({ size: 0 }))).size;

		try {
			const content = await fs.readFile(lastFilePath, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			if (lines.length > 0) {
				const lastLine = JSON.parse(lines[lines.length - 1]);
				const lastTs = lastLine.created_utc;
				if (lastTs) {
					currentTimestamp = Math.max(currentTimestamp, lastTs * 1000 + 1000);
					currentFileIndex = existingFiles.length - 1;
					currentFileBytes = lastFileSize;
					totalBytes = lastFileSize;
					totalItems = lines.length;
					currentFilePath = lastFilePath;

					if (lastFileSize >= maxFileSize * 1024 * 1024) {
						currentFileIndex = existingFiles.length;
						currentFileBytes = 0;
						currentFilePath = "";
					} else {
						currentFileStream = createWriteStream(lastFilePath, { flags: "a" });
					}
				}
			}
		} catch {
			currentTimestamp = startMs;
			currentFileIndex = 0;
			totalBytes = 0;
			totalItems = 0;
		}
	}

	let page = 0;
	let consecutiveErrors = 0;
	let failed = false;
	const maxConsecutiveErrors = 3;

	while (true) {
		if (totalBytes >= maxTotalSize * 1024 * 1024) break;

		if (!currentFileStream) {
			currentFileIndex++;
			currentFileBytes = 0;
			currentFilePath = path.join(outputDir, `${baseName}_part${String(currentFileIndex).padStart(2, "0")}.jsonl`);
			const exists = await fs.access(currentFilePath).then(() => true).catch(() => false);
			currentFileStream = createWriteStream(currentFilePath, { flags: exists ? "a" : "w" });
		}

		let url = `${ARCTIC}/api/${dataType}/search?${entity.type}=${encodeURIComponent(entity.name)}`;
		url += `&limit=auto&sort=asc&after=${Math.floor(currentTimestamp / 1000)}&meta-app=download-tool`;
		if (endMs) url += `&before=${Math.floor(endMs / 1000)}`;

		let data: any;
		try {
			data = await fetchJSON(url);
			consecutiveErrors = 0;
		} catch (err: any) {
			consecutiveErrors++;
			if (consecutiveErrors >= maxConsecutiveErrors) {
				failed = true;
				break;
			}
			await sleep(Math.min(2000 * Math.pow(2, consecutiveErrors), 30_000));
			continue;
		}

		const items: any[] = data?.data ?? [];
		if (items.length === 0) break;

		const lines = items.map((item: any) => JSON.stringify(item)).join("\n") + "\n";
		const encoded = new TextEncoder().encode(lines);
		currentFileStream.write(encoded);
		currentFileBytes += encoded.length;
		totalBytes += encoded.length;
		totalItems += items.length;

		onProgress({
			type: dataType,
			itemsDownloaded: totalItems,
			currentFile: path.basename(currentFilePath),
			currentFileSize: currentFileBytes,
			totalSize: totalBytes,
			currentTimestamp: items[items.length - 1]?.created_utc ?? 0,
			isDone: false,
		});

		if (currentFileBytes >= maxFileSize * 1024 * 1024) {
			await new Promise<void>((resolve) => currentFileStream!.end(resolve));
			currentFileStream = null;
		}

		const lastItem = items[items.length - 1];
		let nextTs: number;
		if (lastItem?.created_utc) {
			nextTs = lastItem.created_utc * 1000;
			if (nextTs <= currentTimestamp) nextTs = currentTimestamp + 1;
		} else {
			nextTs = currentTimestamp + 1000;
		}
		currentTimestamp = nextTs;

		page++;
		if (items.length >= 50) await sleep(200 + Math.random() * 300);
	}

	if (currentFileStream) {
		await new Promise<void>((resolve) => currentFileStream.end(resolve));
	}

	onProgress({
		type: dataType,
		itemsDownloaded: totalItems,
		currentFile: path.basename(currentFilePath),
		currentFileSize: currentFileBytes,
		totalSize: totalBytes,
		currentTimestamp: 0,
		isDone: true,
	});

	return { source: "arctic-shift", itemsDownloaded: totalItems, totalSize: totalBytes, failed };
}

async function downloadPullPushStream(
	entity: EntityInfo,
	dataType: "posts" | "comments",
	startMs: number,
	endMs: number | null,
	outputDir: string,
	maxFileSize: number,
	maxTotalSize: number,
	resume: boolean,
	onProgress: (p: DownloadProgress) => void,
): Promise<DownloadStreamResult> {
	const prefix = entity.type === "author" ? "u_" : "r_";
	const safeName = entity.name.replace(/[^a-zA-Z0-9_-]/g, "_");
	const baseName = `${prefix}${safeName}_${dataType}`;
	const pullpushType = dataType === "posts" ? "submission" : "comment";
	const pageSize = 100;

	await fs.mkdir(outputDir, { recursive: true }).catch(() => {});

	const existingFiles: string[] = [];
	if (resume) {
		const dir = await fs.readdir(outputDir).catch(() => []);
		for (const f of dir) {
			if (f.startsWith(baseName) && f.endsWith(".jsonl")) existingFiles.push(f);
		}
		existingFiles.sort();
	}

	let currentTimestamp = startMs;
	let currentFileIndex = 0;
	let totalBytes = 0;
	let totalItems = 0;
	let currentFileStream: WriteStream | null = null;
	let currentFilePath = "";
	let currentFileBytes = 0;
	const seenIds = new Set<string>();

	if (resume && existingFiles.length > 0) {
		const lastFile = existingFiles[existingFiles.length - 1];
		const lastFilePath = path.join(outputDir, lastFile);
		const lastFileSize = (await fs.stat(lastFilePath).catch(() => ({ size: 0 }))).size;

		try {
			const content = await fs.readFile(lastFilePath, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			for (const line of lines) {
				try {
					const parsed = JSON.parse(line);
					if (parsed?.id) seenIds.add(String(parsed.id));
				} catch {
					// ignore malformed resume lines
				}
			}
			if (lines.length > 0) {
				const lastLine = JSON.parse(lines[lines.length - 1]);
				const lastTs = lastLine.created_utc;
				if (lastTs) {
					currentTimestamp = Math.max(currentTimestamp, lastTs * 1000 + 1000);
					currentFileIndex = existingFiles.length - 1;
					currentFileBytes = lastFileSize;
					totalBytes = lastFileSize;
					totalItems = lines.length;
					currentFilePath = lastFilePath;

					if (lastFileSize >= maxFileSize * 1024 * 1024) {
						currentFileIndex = existingFiles.length;
						currentFileBytes = 0;
						currentFilePath = "";
					} else {
						currentFileStream = createWriteStream(lastFilePath, { flags: "a" });
					}
				}
			}
		} catch {
			currentTimestamp = startMs;
			currentFileIndex = 0;
			totalBytes = 0;
			totalItems = 0;
		}
	}

	let consecutiveErrors = 0;
	let failed = false;
	const maxConsecutiveErrors = 5;

	while (true) {
		if (totalBytes >= maxTotalSize * 1024 * 1024) break;

		if (!currentFileStream) {
			currentFileIndex++;
			currentFileBytes = 0;
			currentFilePath = path.join(outputDir, `${baseName}_part${String(currentFileIndex).padStart(2, "0")}.jsonl`);
			const exists = await fs.access(currentFilePath).then(() => true).catch(() => false);
			currentFileStream = createWriteStream(currentFilePath, { flags: exists ? "a" : "w" });
		}

		let url = `${PULLPUSH}/reddit/search/${pullpushType}/?${entity.type}=${encodeURIComponent(entity.name)}`;
		url += `&size=${pageSize}&sort=asc&sort_type=created_utc&after=${Math.floor(currentTimestamp / 1000)}`;
		if (endMs) url += `&before=${Math.floor(endMs / 1000)}`;

		let data: any;
		try {
			data = await fetchJSON(url);
			consecutiveErrors = 0;
		} catch {
			consecutiveErrors++;
			if (consecutiveErrors >= maxConsecutiveErrors) {
				failed = true;
				break;
			}
			await sleep(Math.min(2500 * Math.pow(2, consecutiveErrors), 45_000));
			continue;
		}

		const rawItems: any[] = Array.isArray(data?.data) ? data.data : [];
		const items = rawItems.filter((item) => {
			const id = String(item?.id ?? "");
			const ts = Number(item?.created_utc ?? 0) * 1000;
			if (!id || seenIds.has(id)) return false;
			if (ts < startMs) return false;
			if (endMs && ts > endMs) return false;
			seenIds.add(id);
			return true;
		});
		if (rawItems.length === 0) break;

		if (items.length > 0) {
			const lines = items.map((item: any) => JSON.stringify(item)).join("\n") + "\n";
			const encoded = new TextEncoder().encode(lines);
			currentFileStream.write(encoded);
			currentFileBytes += encoded.length;
			totalBytes += encoded.length;
			totalItems += items.length;

			onProgress({
				type: dataType,
				itemsDownloaded: totalItems,
				currentFile: path.basename(currentFilePath),
				currentFileSize: currentFileBytes,
				totalSize: totalBytes,
				currentTimestamp: items[items.length - 1]?.created_utc ?? 0,
				isDone: false,
			});

			if (currentFileBytes >= maxFileSize * 1024 * 1024) {
				await new Promise<void>((resolve) => currentFileStream!.end(resolve));
				currentFileStream = null;
			}
		}

		const lastItem = rawItems[rawItems.length - 1];
		let nextTs: number;
		if (lastItem?.created_utc) {
			nextTs = lastItem.created_utc * 1000;
			if (nextTs <= currentTimestamp) nextTs = currentTimestamp + 1000;
		} else {
			nextTs = currentTimestamp + 1000;
		}
		currentTimestamp = nextTs;

		if (rawItems.length < pageSize) break;
		await sleep(750 + Math.random() * 750);
	}

	if (currentFileStream) {
		await new Promise<void>((resolve) => currentFileStream.end(resolve));
	}

	onProgress({
		type: dataType,
		itemsDownloaded: totalItems,
		currentFile: path.basename(currentFilePath),
		currentFileSize: currentFileBytes,
		totalSize: totalBytes,
		currentTimestamp: 0,
		isDone: true,
	});

	return { source: "pullpush", itemsDownloaded: totalItems, totalSize: totalBytes, failed };
}

// ── Programmatic API ──────────────────────────────────────────────────────

/**
 * Download all posts/comments for a Reddit user as JSONL into opts.dir.
 * Non-blocking; calls onProgress with human-readable status lines.
 */
export async function downloadUser(
	username: string,
	options: DownloadUserOptions,
	onProgress?: (message: string) => void,
): Promise<void> {
	const cleanName = username.replace(/^u\//, "");
	const maxSizeMB = options.maxSizeMB ?? 50;
	const maxTotalMB = options.maxTotalMB ?? 300;
	const wantPosts = options.posts ?? true;
	const wantComments = options.comments ?? true;
	const resume = options.resume ?? true;
	const outputDir = path.resolve(options.dir);

	onProgress?.(`[download] Resolving u/${cleanName}...`);
	let resolved: { entity: EntityInfo; earliestMs: number };
	try {
		resolved = await resolveEntityInfoWithFallback(cleanName, "author", onProgress);
	} catch (err: any) {
		if (!options.after) throw err;
		onProgress?.(`[download] Archive lookup failed, but --after was provided; continuing from requested date.`);
		resolved = {
			entity: { type: "author", name: cleanName, label: `u/${cleanName}` },
			earliestMs: toTimestamp(options.after),
		};
	}
	const { entity, earliestMs } = resolved;

	let startMs = earliestMs;
	let endMs: number | null = null;
	if (options.after) startMs = toTimestamp(options.after);
	if (options.before) endMs = toTimestamp(options.before);

	onProgress?.(`[download] Range ${new Date(startMs).toISOString().slice(0, 10)} → ${endMs ? new Date(endMs).toISOString().slice(0, 10) : "now"}`);

	const dataTypes: ("posts" | "comments")[] = [];
	if (wantPosts) dataTypes.push("posts");
	if (wantComments) dataTypes.push("comments");

	const totals: Record<"posts" | "comments", number> = { posts: 0, comments: 0 };
	for (const dt of dataTypes) {
		onProgress?.(`[download] Starting ${dt} via Arctic Shift...`);
		const reportProgress = (source: DownloadSource) => (p: DownloadProgress) => {
			if (p.itemsDownloaded % 500 === 0 || p.isDone) {
				onProgress?.(`[${dt}:${sourceLabel(source)}] ${p.itemsDownloaded} items · ${formatBytes(p.totalSize)}${p.isDone ? " (done)" : ""}`);
			}
		};

		const arctic = await downloadStream(entity, dt, startMs, endMs, outputDir, maxSizeMB, maxTotalMB, resume, reportProgress("arctic-shift"));
		if (arctic.itemsDownloaded > 0) {
			totals[dt] += arctic.itemsDownloaded;
			if (arctic.failed) {
				onProgress?.(`[${dt}] Arctic Shift stopped after ${arctic.itemsDownloaded} item(s); keeping partial archive and not mixing providers for this file.`);
			}
			continue;
		}

		onProgress?.(`[${dt}] Arctic Shift returned no data${arctic.failed ? " after repeated errors" : ""}; falling back to PullPush...`);
		const pullpush = await downloadPullPushStream(entity, dt, startMs, endMs, outputDir, maxSizeMB, maxTotalMB, resume, reportProgress("pullpush"));
		totals[dt] += pullpush.itemsDownloaded;
		if (pullpush.failed) {
			onProgress?.(`[${dt}] PullPush stopped after ${pullpush.itemsDownloaded} item(s) due repeated errors.`);
		}
	}

	onProgress?.(`[download] Complete → ${outputDir} (${totals.posts.toLocaleString()} post(s), ${totals.comments.toLocaleString()} comment(s))`);
}

// ── JSONL loading / analysis ──────────────────────────────────────────────

/** Read JSONL files for a user and return parsed records. */
export async function loadJsonlFiles(
	dir: string,
	username: string,
	dataType: "posts" | "comments",
): Promise<any[]> {
	const prefix = `u_${username.replace(/[^a-zA-Z0-9_-]/g, "_")}_${dataType}`;
	const files = (await fs.readdir(dir).catch(() => []))
		.filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"))
		.sort();

	const allItems: any[] = [];
	for (const file of files) {
		const content = await fs.readFile(path.join(dir, file), "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				allItems.push(JSON.parse(line));
			} catch {
				// skip malformed lines
			}
		}
	}
	return allItems;
}

/** Analyze JSONL data and return stats. */
export function analyzeData(items: any[], _dataType: "posts" | "comments") {
	const byYear = new Map<number, number>();
	const bySub = new Map<string, number>();
	let deleted = 0;
	let removed = 0;

	for (const item of items) {
		const ts = item.created_utc;
		if (ts) {
			const year = new Date(ts * 1000).getFullYear();
			byYear.set(year, (byYear.get(year) ?? 0) + 1);
		}
		const sub = item.subreddit;
		if (sub) bySub.set(sub, (bySub.get(sub) ?? 0) + 1);
		const body = item.body ?? item.selftext ?? "";
		if (body === "[deleted]" || item.author === "[deleted]") deleted++;
		if (body === "[removed]") removed++;
	}

	return {
		total: items.length,
		deleted,
		removed,
		byYear: Object.fromEntries([...byYear.entries()].sort((a, b) => a[0] - b[0])),
		bySub: Object.fromEntries([...bySub.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)),
	};
}

/** Generate a LLM-friendly formatted report from loaded data. */
export function formatLLMReport(username: string, posts: any[], comments: any[]): string {
	const lines: string[] = [];
	lines.push(`=== REDDIT PROFILE: u/${username} ===`);

	const allTimestamps = [
		...posts.map((p) => p.created_utc),
		...comments.map((c) => c.created_utc),
	].filter((t) => t > 0);

	const earliest = allTimestamps.length > 0 ? new Date(Math.min(...allTimestamps) * 1000).toISOString().slice(0, 10) : "unknown";
	const latest = allTimestamps.length > 0 ? new Date(Math.max(...allTimestamps) * 1000).toISOString().slice(0, 10) : "unknown";

	lines.push(`Data range: ${earliest} to ${latest}`);
	lines.push(`Posts: ${posts.length}  |  Comments: ${comments.length}`);

	const deletedPosts = posts.filter((p) => (p.body ?? p.selftext ?? "") === "[deleted]" || p.author === "[deleted]");
	const deletedComments = comments.filter((c) => (c.body ?? "") === "[deleted]" || c.author === "[deleted]");
	lines.push(`Deleted/Removed: ${deletedPosts.length} posts, ${deletedComments.length} comments`);
	lines.push(``);

	const subs = new Map<string, number>();
	for (const c of comments) subs.set(c.subreddit, (subs.get(c.subreddit) ?? 0) + 1);
	for (const p of posts) subs.set(p.subreddit, (subs.get(p.subreddit) ?? 0) + 1);
	const topSubs = [...subs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
	lines.push(`Top subreddits: ${topSubs.map(([s, n]) => `r/${s}(${n})`).join(", ")}`);
	lines.push(``);

	const years = new Map<number, { posts: number; comments: number }>();
	for (const p of posts) {
		const y = new Date(p.created_utc * 1000).getFullYear();
		if (!years.has(y)) years.set(y, { posts: 0, comments: 0 });
		years.get(y)!.posts++;
	}
	for (const c of comments) {
		const y = new Date(c.created_utc * 1000).getFullYear();
		if (!years.has(y)) years.set(y, { posts: 0, comments: 0 });
		years.get(y)!.comments++;
	}
	lines.push(`Activity by year:`);
	for (const [y, counts] of [...years.entries()].sort((a, b) => a[0] - b[0])) {
		lines.push(`  ${y}: ${counts.posts} posts, ${counts.comments} comments`);
	}
	lines.push(``);

	if (deletedPosts.length > 0) {
		lines.push(`--- DELETED/REMOVED POSTS (${deletedPosts.length}) ---`);
		for (const p of deletedPosts.slice(0, 50)) {
			const date = new Date(p.created_utc * 1000).toISOString().split("T")[0];
			lines.push(`[${date}] r/${p.subreddit} | ${p.title}`);
			if (p.selftext && !["[deleted]", "[removed]"].includes(p.selftext)) lines.push(`  Body: ${p.selftext.slice(0, 500)}`);
		}
	}

	if (deletedComments.length > 0) {
		lines.push(`\n--- DELETED/REMOVED COMMENTS (${deletedComments.length}) ---`);
		for (const c of deletedComments.slice(0, 80)) {
			const date = new Date(c.created_utc * 1000).toISOString().split("T")[0];
			lines.push(`[${date}] r/${c.subreddit} | ${c.body.slice(0, 300)}`);
		}
	}

	const activePosts = posts.filter((p) => (p.body ?? p.selftext ?? "") !== "[deleted]" && (p.body ?? p.selftext ?? "") !== "[removed]" && p.author !== "[deleted]");
	if (activePosts.length > 0) {
		lines.push(`\n--- ACTIVE POSTS (${activePosts.length}) ---`);
		for (const p of activePosts.slice(0, 30)) {
			const date = new Date(p.created_utc * 1000).toISOString().split("T")[0];
			lines.push(`[${date}] r/${p.subreddit} | ${p.title}`);
			if (p.selftext) lines.push(`  Body: ${p.selftext.slice(0, 300)}`);
		}
	}

	const activeComments = comments.filter((c) => (c.body ?? "") !== "[deleted]" && (c.body ?? "") !== "[removed]" && c.author !== "[deleted]");
	if (activeComments.length > 0) {
		lines.push(`\n--- ACTIVE COMMENTS (${activeComments.length}, showing up to 200) ---`);
		for (const c of activeComments.slice(0, 200)) {
			const date = new Date(c.created_utc * 1000).toISOString().split("T")[0];
			lines.push(`[${date}] r/${c.subreddit} | ${c.body.slice(0, 300)}`);
		}
	}

	return lines.join("\n");
}

// ── CLI ────────────────────────────────────────────────────────────────────

interface CliOptions {
	username?: string;
	subreddit?: string;
	dir: string;
	maxSizeMB: number;
	maxTotalMB: number;
	posts: boolean;
	comments: boolean;
	resume: boolean;
	after?: string;
	before?: string;
	analyze: boolean;
	format: "stats" | "llm";
}

function parseArgs(): CliOptions {
	const args = process.argv.slice(2);
	const opts: CliOptions = {
		dir: "./data",
		maxSizeMB: 50,
		maxTotalMB: 300,
		posts: true,
		comments: true,
		resume: true,
		analyze: false,
		format: "stats",
	};

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--dir" || a === "-d") opts.dir = args[++i];
		else if (a === "--max-size") opts.maxSizeMB = parseInt(args[++i]) || 50;
		else if (a === "--max-total") opts.maxTotalMB = parseInt(args[++i]) || 300;
		else if (a === "--after") opts.after = args[++i];
		else if (a === "--before") opts.before = args[++i];
		else if (a === "--posts-only") { opts.posts = true; opts.comments = false; }
		else if (a === "--comments-only") { opts.posts = false; opts.comments = true; }
		else if (a === "--no-resume") opts.resume = false;
		else if (a === "--subreddit" || a === "-s") opts.subreddit = args[++i];
		else if (a === "--analyze" || a === "-a") opts.analyze = true;
		else if (a === "--format") opts.format = args[++i] as "stats" | "llm";
		else if (!a.startsWith("-")) opts.username = a.replace(/^u\//, "");
	}

	if (!opts.username && !opts.subreddit) {
		console.error("Usage: bun run src/reddit/download.ts <username> [options]");
		console.error("       bun run src/reddit/download.ts --subreddit <name>");
		console.error("       bun run src/reddit/download.ts --analyze <username> [--format llm|stats]");
		console.error("");
		console.error("Options:");
		console.error("  --dir, -d <path>        Output directory (default: ./data)");
		console.error("  --max-size <MB>         Max per-file size (default: 50)");
		console.error("  --max-total <MB>        Max total download (default: 300)");
		console.error("  --after/--before <date> Date range (YYYY-MM-DD)");
		console.error("  --posts-only/--comments-only");
		console.error("  --no-resume");
		process.exit(1);
	}

	return opts;
}

async function runAnalyze(opts: CliOptions) {
	const outputDir = path.resolve(opts.dir);
	const username = opts.username!;

	console.error(`[analyze] Reading JSONL files from ${outputDir}...`);
	const posts = await loadJsonlFiles(outputDir, username, "posts");
	const comments = await loadJsonlFiles(outputDir, username, "comments");
	console.error(`[analyze] Loaded ${posts.length} posts, ${comments.length} comments`);

	if (opts.format === "llm") {
		console.log(formatLLMReport(username, posts, comments));
		return;
	}

	const postStats = analyzeData(posts, "posts");
	const commentStats = analyzeData(comments, "comments");

	console.log(`\nAnalysis for u/${username} (${outputDir})\n`);
	console.log(`Posts: ${postStats.total} (${postStats.deleted} deleted, ${postStats.removed} removed)`);
	console.log(`Comments: ${commentStats.total} (${commentStats.deleted} deleted, ${commentStats.removed} removed)\n`);

	console.log(`Activity by year:`);
	const allYears = new Set([...Object.keys(postStats.byYear), ...Object.keys(commentStats.byYear)]);
	for (const y of [...allYears].sort()) {
		const p = postStats.byYear[y] ?? 0;
		const c = commentStats.byYear[y] ?? 0;
		console.log(`  ${y}:  ${String(p).padStart(4)} posts  ${String(c).padStart(5)} comments`);
	}
}

async function main() {
	const opts = parseArgs();

	if (opts.analyze) {
		await runAnalyze(opts);
		return;
	}

	const name = (opts.subreddit ?? opts.username!) as string;
	await downloadUser(
		name,
		{
			dir: opts.dir,
			maxSizeMB: opts.maxSizeMB,
			maxTotalMB: opts.maxTotalMB,
			posts: opts.posts,
			comments: opts.comments,
			resume: opts.resume,
			after: opts.after,
			before: opts.before,
		},
		(message) => console.error(message),
	);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	main().catch((err) => {
		console.error("Fatal:", err);
		process.exit(1);
	});
}
