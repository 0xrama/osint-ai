/**
 * Reddit archive JSONL downloader + loader.
 *
 * `downloadUser()` streams a user's posts/comments into JSONL under a data dir
 * (in-process, with progress callbacks); `loadJsonlFiles()` reads them back.
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
