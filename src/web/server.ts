/**
 * Local web dashboard for osint-ai.
 *
 * The dashboard is intentionally a thin HTTP layer over the existing audit
 * pipeline: scans use runAudit(), finished reports are still written under
 * reports/, and the browser reads those same artifacts so old analyses can be
 * reviewed without starting a new scan.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { loadEnvFile } from "../runtime/config.ts";
import { assertLLMConfig, resolveProvider, type Provider } from "../runtime/providers/index.ts";
import { extractDirectIdentifiers, type DirectIdentifiers } from "../analysis/extract.ts";
import { extractReportBrief, runAudit, saveJsonReport, saveReport, type AuditCallbacks } from "../analysis/pipeline.ts";
import { answerChatTurn, type ChatContext, type ChatMessage } from "../analysis/chat.ts";
import type { Candidate } from "../types.ts";

const ROOT_DIR = resolve(import.meta.dir, "../..");
const REPORTS_DIR = join(ROOT_DIR, "reports");
const DATA_DIR = join(ROOT_DIR, "data");
const STATIC_DIR = join(import.meta.dir, "static");
const PORT = Number.parseInt(process.env.DASHBOARD_PORT ?? process.env.PORT ?? "4173", 10);

loadEnvFile();
mkdirSync(REPORTS_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });

interface ReportSummary {
	file: string;
	username: string;
	type: "markdown" | "json";
	generatedAt: string;
	modifiedAt: string;
	size: number;
	risk: string;
	brief: string;
	identifierCount: number;
	findingCount: number;
}

interface ReportDetail {
	summary: ReportSummary;
	content: string;
	directIdentifiers: DirectIdentifiers;
}

interface ScanRequest {
	username?: string;
	deep?: boolean;
	web?: boolean;
	years?: number;
	json?: boolean;
	provider?: "auto" | Provider;
	model?: string;
	subjectName?: string;
}

interface ScanLog {
	at: string;
	kind: "status" | "progress" | "tool" | "result" | "token" | "error";
	message: string;
}

interface ScanJob {
	id: string;
	status: "queued" | "running" | "completed" | "failed";
	options: Required<Pick<ScanRequest, "username" | "deep" | "web" | "years" | "json">> & {
		provider: "auto" | Provider;
		model: string;
		subjectName: string;
	};
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	reportFile?: string;
	brief?: string;
	error?: string;
	logs: ScanLog[];
	subscribers: Set<ReadableStreamDefaultController<Uint8Array>>;
}

const jobs = new Map<string, ScanJob>();
const encoder = new TextEncoder();

function cleanUsername(value: string): string {
	return value.trim().replace(/^u\//i, "");
}

function validateUsername(username: string): void {
	if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) {
		throw new Error("Enter a valid Reddit username: 3-20 chars, letters/numbers/_/-.");
	}
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function errorResponse(message: string, status = 400): Response {
	return jsonResponse({ error: message }, status);
}

function readJsonBody<T>(request: Request): Promise<T> {
	return request.json().catch(() => {
		throw new Error("Expected a JSON request body.");
	});
}

function safeReportFile(file: string): string {
	const name = basename(decodeURIComponent(file));
	if (!/^[A-Za-z0-9._ -]+\.(md|json)$/i.test(name)) throw new Error("Unknown report file.");
	const path = join(REPORTS_DIR, name);
	if (!existsSync(path)) throw new Error("Report not found.");
	return path;
}

function parseReportName(file: string, content = ""): { username: string; generatedAt: string } {
	const generatedMatch = file.match(/^report_(.+)_(\d{4}-\d{2}-\d{2}T.+)\.(md|json)$/i);
	if (generatedMatch) {
		return {
			username: generatedMatch[1],
			generatedAt: timestampFromFilename(generatedMatch[2]),
		};
	}

	const manualMatch = file.match(/^manual_(.+)\.(md|json)$/i);
	const headingMatch = content.match(/\bu\/([A-Za-z0-9_-]{3,20})\b/i);
	return {
		username: headingMatch?.[1] ?? manualMatch?.[1] ?? "unknown",
		generatedAt: "",
	};
}

function timestampFromFilename(value: string): string {
	const normalized = value.replace(
		/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
		"$1:$2:$3.$4",
	);
	const date = new Date(normalized);
	return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function contentFromReport(raw: string, type: "markdown" | "json"): string {
	if (type === "markdown") return raw;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed?.content === "string") return parsed.content;
		return JSON.stringify(parsed, null, 2);
	} catch {
		return raw;
	}
}

function riskFromContent(raw: string, type: "markdown" | "json"): string {
	if (type === "json") {
		try {
			const parsed = JSON.parse(raw);
			const risk = parsed?.structured?.overallRisk ?? parsed?.overallRisk;
			if (typeof risk === "string" && risk.trim()) return risk.trim();
		} catch {
			// Fall through to markdown-style extraction.
		}
	}
	const match = raw.match(/\b(?:overall\s+risk|risk\s+level|risk)\b[^A-Za-z0-9]{0,24}(critical|high|medium|low)\b/i);
	return match?.[1]?.toLowerCase() ?? "unknown";
}

function findingCountFromContent(raw: string, type: "markdown" | "json"): number {
	if (type === "json") {
		try {
			const parsed = JSON.parse(raw);
			const findings = parsed?.structured?.findings ?? parsed?.findings;
			return Array.isArray(findings) ? findings.length : 0;
		} catch {
			return 0;
		}
	}
	const headingMatches = raw.match(/^#{2,4}\s+.*finding/gim);
	if (headingMatches?.length) return headingMatches.length;
	const bulletMatches = raw.match(/^\s*[-*]\s+\*\*(?:finding|claim|risk)/gim);
	return bulletMatches?.length ?? 0;
}

function generatedAtFromContent(raw: string, fallback: string): string {
	const match = raw.match(/^Generated:\s*(.+)$/im);
	if (!match) return fallback;
	const date = new Date(match[1].trim());
	return Number.isNaN(date.getTime()) ? match[1].trim() : date.toISOString();
}

// summarizeReport runs five regex passes plus a full identifier extraction on
// every file every time /api/reports is hit. Memoize by (file, mtimeMs, size)
// so the second and subsequent calls within an unchanged file are cache hits.
const summaryCache = new Map<string, { mtimeMs: number; size: number; summary: ReportSummary }>();

function summarizeReport(file: string): ReportSummary {
	const path = safeReportFile(file);
	const stats = statSync(path);
	const cached = summaryCache.get(file);
	if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
		return cached.summary;
	}
	const type = extname(file).toLowerCase() === ".json" ? "json" : "markdown";
	const raw = readFileSync(path, "utf-8");
	const content = contentFromReport(raw, type);
	const parsed = parseReportName(file, content);
	const directIdentifiers = extractDirectIdentifiers([content], parsed.username);
	const brief = extractReportBrief(content);

	const summary: ReportSummary = {
		file,
		username: parsed.username,
		type,
		generatedAt: generatedAtFromContent(raw, parsed.generatedAt || stats.mtime.toISOString()),
		modifiedAt: stats.mtime.toISOString(),
		size: stats.size,
		risk: riskFromContent(raw, type),
		brief,
		identifierCount: directIdentifiers.emails.length + directIdentifiers.socialHandles.length,
		findingCount: findingCountFromContent(raw, type),
	};
	summaryCache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, summary });
	return summary;
}

/** Return all saved report artifacts, newest first. */
export function listReports(): ReportSummary[] {
	if (!existsSync(REPORTS_DIR)) return [];
	return readdirSync(REPORTS_DIR)
		.filter((file) => /^[A-Za-z0-9._ -]+\.(md|json)$/i.test(file))
		.map((file) => summarizeReport(file))
		.sort((a, b) => Date.parse(b.generatedAt || b.modifiedAt) - Date.parse(a.generatedAt || a.modifiedAt));
}

/** Read one saved report and attach deterministic identifiers for review. */
export function getReport(file: string): ReportDetail {
	const path = safeReportFile(file);
	const summary = summarizeReport(basename(path));
	const raw = readFileSync(path, "utf-8");
	const content = contentFromReport(raw, summary.type);
	const directIdentifiers = extractDirectIdentifiers([content], summary.username);
	return { summary, content, directIdentifiers };
}

function serializeJob(job: ScanJob): Omit<ScanJob, "subscribers"> {
	return {
		id: job.id,
		status: job.status,
		options: job.options,
		startedAt: job.startedAt,
		updatedAt: job.updatedAt,
		completedAt: job.completedAt,
		reportFile: job.reportFile,
		brief: job.brief,
		error: job.error,
		logs: job.logs,
	};
}

function sendEvent(controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown): void {
	controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function addJobLog(job: ScanJob, kind: ScanLog["kind"], message: string): void {
	const entry = { at: new Date().toISOString(), kind, message };
	job.logs.push(entry);
	job.updatedAt = entry.at;
	for (const subscriber of job.subscribers) sendEvent(subscriber, "log", entry);
}

function broadcastJob(job: ScanJob, event = "job"): void {
	const payload = serializeJob(job);
	for (const subscriber of job.subscribers) sendEvent(subscriber, event, payload);
}

function normalizeScanRequest(input: ScanRequest): ScanJob["options"] {
	const username = cleanUsername(input.username ?? "");
	validateUsername(username);
	const provider =
		input.provider === "openai" ||
		input.provider === "claude-code" ||
		input.provider === "codex-cli" ||
		input.provider === "pi" ||
		input.provider === "antigravity"
			? input.provider
			: "auto";
	const years = Number.parseInt(String(input.years ?? 7), 10);
	if (!Number.isFinite(years) || years < 1 || years > 20) {
		throw new Error("Years must be a number from 1 to 20.");
	}
	return {
		username,
		deep: !!input.deep,
		web: !!input.web,
		years,
		json: !!input.json,
		provider,
		model: input.model?.trim() ?? "",
		subjectName: input.subjectName?.trim() ?? "",
	};
}

function applyProviderOptions(options: ScanJob["options"]): void {
	if (options.provider !== "auto") process.env.LLM_PROVIDER = options.provider;
	if (options.model) {
		const provider = resolveProvider();
		if (provider === "claude-code") process.env.CLAUDE_CODE_MODEL = options.model;
		else if (provider === "codex-cli") process.env.CODEX_CLI_MODEL = options.model;
		else if (provider === "pi") process.env.PI_MODEL = options.model;
		else if (provider === "antigravity") process.env.ANTIGRAVITY_MODEL = options.model;
		else process.env.OPENAI_MODEL = options.model;
	}
}

// Interim runtime-isolation guard. Scans select provider/model by MUTATING
// process.env (applyProviderOptions) and the provider layer caches ONE global
// client, so two concurrent scans with different providers/models would read
// each other's environment mid-run (wrong provider/model for some calls).
// Serializing scans eliminates that interference. Phase 4 (per-run
// RuntimeContext + dependency injection) will replace this mutex with
// run-scoped clients, at which point this guard can be relaxed to a bounded
// concurrency > 1.
let scanChain: Promise<unknown> = Promise.resolve();
function serializeScan<T>(fn: () => Promise<T>): Promise<T> {
	const next = scanChain.then(fn, fn);
	scanChain = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

async function startScan(input: ScanRequest): Promise<ScanJob> {
	const options = normalizeScanRequest(input);
	// Validate up-front (POST-time 400 on bad config), but DEFER the
	// process.env mutation into runScanJob so concurrent scans can't stomp on
	// each other's environment (see serializeScan).
	assertLLMConfig({ provider: options.provider === "auto" ? undefined : options.provider });

	const now = new Date().toISOString();
	const job: ScanJob = {
		id: crypto.randomUUID(),
		status: "queued",
		options,
		startedAt: now,
		updatedAt: now,
		logs: [],
		subscribers: new Set(),
	};
	jobs.set(job.id, job);
	addJobLog(job, "status", "Queued (scans run one at a time to keep provider/model isolation).");
	void serializeScan(() => runScanJob(job));
	return job;
}

async function runScanJob(job: ScanJob): Promise<void> {
	// Now that earlier scans have finished, apply THIS job's provider/model to
	// process.env in isolation (serialized by startScan).
	applyProviderOptions(job.options);
	job.status = "running";
	broadcastJob(job);
	addJobLog(job, "status", `Starting scan for u/${job.options.username}`);

	const candidate: Candidate | undefined = job.options.subjectName ? { name: job.options.subjectName } : undefined;
	const callbacks: AuditCallbacks = {
		onStatus: (message) => addJobLog(job, "status", message),
		onProgress: (message) => addJobLog(job, "progress", message),
		onToolCall: (name, args) => addJobLog(job, "tool", `${name} ${JSON.stringify(args)}`),
		onToolResult: (name, result) => addJobLog(job, "result", `${name} complete (${JSON.stringify(result).length.toLocaleString()} chars)`),
		onToken: (text) => addJobLog(job, "token", `Report draft received (${text.length.toLocaleString()} chars)`),
	};

	try {
		const result = await runAudit({
			username: job.options.username,
			deep: job.options.deep,
			years: job.options.years,
			web: job.options.web,
			dataDir: DATA_DIR,
			candidate,
		}, callbacks);
		const filepath = job.options.json
			? saveJsonReport(job.options.username, result.json ?? { content: result.content })
			: saveReport(job.options.username, result.content);
		job.status = "completed";
		job.reportFile = basename(filepath);
		job.brief = result.brief;
		job.completedAt = new Date().toISOString();
		job.updatedAt = job.completedAt;
		addJobLog(job, "status", `Saved ${job.reportFile}`);
		broadcastJob(job, "complete");
	} catch (err: any) {
		job.status = "failed";
		job.error = err?.message ?? String(err);
		job.completedAt = new Date().toISOString();
		job.updatedAt = job.completedAt;
		addJobLog(job, "error", job.error);
		broadcastJob(job, "failed");
	}
}

function compareReports(leftFile: string, rightFile: string): unknown {
	const left = getReport(leftFile);
	const right = getReport(rightFile);
	const leftEmails = new Set(left.directIdentifiers.emails);
	const rightEmails = new Set(right.directIdentifiers.emails);
	const leftHandles = new Set(left.directIdentifiers.socialHandles.map((h) => `${h.platform}:${h.handle.toLowerCase()}`));
	const rightHandles = new Set(right.directIdentifiers.socialHandles.map((h) => `${h.platform}:${h.handle.toLowerCase()}`));

	return {
		left,
		right,
		overlap: {
			emails: [...leftEmails].filter((email) => rightEmails.has(email)),
			handles: [...leftHandles].filter((handle) => rightHandles.has(handle)),
		},
	};
}

async function serveStatic(pathname: string): Promise<Response> {
	const target = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const safeTarget = target.split("/").filter(Boolean).join("/");
	const filePath = join(STATIC_DIR, safeTarget);
	if (!filePath.startsWith(STATIC_DIR) || !existsSync(filePath)) {
		return Bun.file(join(STATIC_DIR, "index.html")).exists()
			.then((exists) => exists ? new Response(Bun.file(join(STATIC_DIR, "index.html"))) : errorResponse("Not found", 404));
	}
	const mime = {
		".html": "text/html; charset=utf-8",
		".css": "text/css; charset=utf-8",
		".js": "application/javascript; charset=utf-8",
		".png": "image/png",
	}[extname(filePath)] ?? "application/octet-stream";
	return new Response(Bun.file(filePath), { headers: { "content-type": mime } });
}

async function handleApi(request: Request, url: URL): Promise<Response> {
	const { pathname } = url;
	if (request.method === "GET" && pathname === "/api/health") {
		return jsonResponse({
			ok: true,
			provider: resolveProvider(),
			reports: listReports().length,
			jobs: jobs.size,
		});
	}
	if (request.method === "GET" && pathname === "/api/reports") return jsonResponse({ reports: listReports() });
	if (request.method === "GET" && pathname.startsWith("/api/reports/")) {
		const file = pathname.slice("/api/reports/".length);
		const detail = getReport(file);
		return jsonResponse(detail);
	}
	if (request.method === "GET" && pathname.startsWith("/api/download/")) {
		const path = safeReportFile(pathname.slice("/api/download/".length));
		return new Response(Bun.file(path), {
			headers: {
				"content-type": extname(path) === ".json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
				"content-disposition": `attachment; filename="${basename(path)}"`,
			},
		});
	}
	if (request.method === "POST" && pathname === "/api/chat") {
		const body = await readJsonBody<{ file?: string; question?: string; history?: ChatMessage[] }>(request);
		if (!body.file || !body.question?.trim()) {
			return errorResponse("Provide a report file and a question.");
		}
		let detail: ReportDetail;
		try {
			detail = getReport(body.file);
		} catch (err: any) {
			return errorResponse(err?.message ?? String(err), 404);
		}
		const ctx: ChatContext = {
			username: detail.summary.username,
			report: detail.content,
			directIdentifiers: detail.directIdentifiers,
		};
		try {
			const answer = await answerChatTurn(ctx, body.history ?? [], body.question);
			return jsonResponse({ answer });
		} catch (err: any) {
			return errorResponse(`Chat backend failed: ${err?.message ?? String(err)}`, 502);
		}
	}
	if (request.method === "POST" && pathname === "/api/compare") {
		const body = await readJsonBody<{ left: string; right: string }>(request);
		if (!body.left || !body.right) return errorResponse("Choose two reports to compare.");
		return jsonResponse(compareReports(body.left, body.right));
	}
	if (request.method === "GET" && pathname === "/api/scans") {
		return jsonResponse({ jobs: [...jobs.values()].map(serializeJob).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)) });
	}
	if (request.method === "POST" && pathname === "/api/scans") {
		const body = await readJsonBody<ScanRequest>(request);
		try {
			const job = await startScan(body);
			return jsonResponse({ job: serializeJob(job) }, 202);
		} catch (err: any) {
			return errorResponse(err?.message ?? String(err), 400);
		}
	}
	if (request.method === "GET" && /^\/api\/scans\/[^/]+$/.test(pathname)) {
		const id = pathname.split("/").pop() ?? "";
		const job = jobs.get(id);
		if (!job) return errorResponse("Scan job not found.", 404);
		return jsonResponse({ job: serializeJob(job) });
	}
	if (request.method === "GET" && /^\/api\/scans\/[^/]+\/events$/.test(pathname)) {
		const id = pathname.split("/")[3];
		const job = jobs.get(id);
		if (!job) return errorResponse("Scan job not found.", 404);
		let activeController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				activeController = controller;
				job.subscribers.add(controller);
				sendEvent(controller, "job", serializeJob(job));
				for (const log of job.logs) sendEvent(controller, "log", log);
			},
			cancel() {
				if (activeController) job.subscribers.delete(activeController);
			},
		});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
			},
		});
	}
	return errorResponse("Not found", 404);
}

Bun.serve({
	port: PORT,
	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (url.pathname.startsWith("/api/")) return await handleApi(request, url);
			return await serveStatic(url.pathname);
		} catch (err: any) {
			return errorResponse(err?.message ?? String(err), 500);
		}
	},
});

console.log(`osint-ai dashboard: http://localhost:${PORT}`);
