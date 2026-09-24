#!/usr/bin/env bun
/**
 * osint-ai — stable CLI entry point.
 *
 * Five interchangeable runtimes. Configure via .env.local or env:
 *   OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL for the API backend
 *   LLM_PROVIDER      openai | claude-code | codex-cli | pi | antigravity
 *   CLAUDE_CODE_BIN / CLAUDE_CODE_MODEL for the Claude Code backend
 *   CODEX_CLI_BIN / CODEX_CLI_MODEL for the Codex CLI backend
 *   PI_BIN / PI_MODEL / PI_PROVIDER / PI_THINKING for the Pi backend
 *   ANTIGRAVITY_BIN / ANTIGRAVITY_MODEL / ANTIGRAVITY_EFFORT for the Antigravity backend
 *   FIRECRAWL_API_KEY (optional — enables web intelligence)
 *
 * Usage:
 *   bun run src/index.tsx                          # interactive CLI
 *   bun run src/index.tsx <username>               # standard scan
 *   bun run src/index.tsx -f <username>            # full investigation (deep + web + twitter)
 *   bun run src/index.tsx -f -c <username>         # full investigation, then chat with the verdict
 *   bun run src/index.tsx --deep --years 10 --web <username>
 *   bun run src/index.tsx --twitter <username>           # twitter-cli identity pass (burner account, read-only)
 *   bun run src/index.tsx --provider pi <username>            # use local pi session
 *   bun run src/index.tsx --provider antigravity <username>   # use local antigravity session
 *   bun run src/index.tsx --provider codex-cli <username>     # use local codex session
 *   bun run src/index.tsx --subject-name "Jane Doe" --web <username>
 *   bun run src/index.tsx --tui                    # legacy OpenTUI interface
 *   bun run src/index.tsx --chat <username>        # chat about the latest saved report
 *   bun run src/index.tsx --init-env               # create .env.local template
 *   bun run src/index.tsx --list-models            # list provider model ids
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { loadEnvFile, ensureEnvExample } from "./runtime/config.ts";
import { assertLLMConfig, resolveProvider, type Provider } from "./runtime/providers/index.ts";
import { describeModels } from "./config/models.ts";
import { runAudit, saveReport, saveJsonReport, type AuditCallbacks } from "./analysis/pipeline.ts";
import { startChatRepl, type ChatContext } from "./analysis/chat.ts";

interface CliOptions {
	deep: boolean;
	web: boolean;
	twitter: boolean;
	years: number;
	tui: boolean;
	listModels: boolean;
	json: boolean;
	chat: boolean;
	provider?: Provider;
	model?: string;
	username: string;
	subjectName?: string;
}

const DATA_DIR = join(import.meta.dir, "..", "data");
const PROVIDER_ALIASES: Record<string, Provider> = {
	openai: "openai",
	"claude-code": "claude-code",
	claudecode: "claude-code",
	claude: "claude-code",
	"codex-cli": "codex-cli",
	codexcli: "codex-cli",
	codex: "codex-cli",
	pi: "pi",
	antigravity: "antigravity",
	antigrav: "antigravity",
	agy: "antigravity",
};


function usage(): never {
	console.log(`
osint-ai — OSINT AI CLI (OpenAI-compatible)

Usage:
  bun run src/index.tsx                              Interactive CLI prompts
  bun run src/index.tsx <username>                   Run a standard scan
  bun run src/index.tsx -f <username>                Full investigation (deep + web + twitter) in one flag
  bun run src/index.tsx -f -c <username>             Full investigation, then chat with the verdict
  bun run src/index.tsx --deep <username>            Deep multi-agent scan
  bun run src/index.tsx --deep --years 10 <username> Deep scan (10 years)
  bun run src/index.tsx --web <username>             Enable Firecrawl web tools
  bun run src/index.tsx --subject-name "Full Name" --web <username>
                                                     Test a candidate identity hypothesis
  bun run src/index.tsx --chat <username>            Chat about the latest saved report
  bun run src/index.tsx --tui                        Legacy OpenTUI interface
  bun run src/index.tsx --init-env                   Create .env.local template
  bun run src/index.tsx --list-models                List model ids from OPENAI_BASE_URL

Options:
  -f, --full        Full investigation: --deep + --web + --twitter in one flag
  -d, --deep        Deep multi-agent scan (downloads JSONL, dispatches sub-agents)
  -y, --years N     Years to scan back (default: 7 for deep)
  -w, --web         Enable Firecrawl web intelligence enrichment
  -t, --twitter     Enable the Twitter/X identity pass via twitter-cli (burner account; read-only)
  -j, --json        Emit machine-readable JSON (findings + direct identifiers) instead of a markdown report
  -c, --chat        After the scan, start an interactive chat grounded in the report. Add to any scan flag to combine; alone, loads the latest saved report.
      --provider X  LLM backend: 'openai', 'claude-code', 'codex-cli', 'pi', or 'antigravity'. Default: auto-detect
      --model X     Override the model id (else OPENAI_MODEL / CLAUDE_CODE_MODEL / CODEX_CLI_MODEL / PI_MODEL / ANTIGRAVITY_MODEL / role defaults)
      --subject-name X  Optional candidate real-world identity to verify against the evidence
      --tui         Launch the legacy full-screen TUI
      --init-env    Create a .env.local template if missing
      --list-models Query the configured OpenAI-compatible /models endpoint
  -h, --help        Show this help

Env:
  OPENAI_API_KEY      Required for --provider openai
  OPENAI_BASE_URL     Default: https://api.openai.com/v1
  OPENAI_MODEL        Default: role split in src/config/models.ts (deepseek-v4-flash/pro)
  CLAUDE_CODE_MODEL   Optional model alias for --provider claude-code
  CODEX_CLI_MODEL     Optional model alias for --provider codex-cli
  PI_MODEL            Optional model alias for --provider pi
  ANTIGRAVITY_MODEL   Optional model alias for --provider antigravity (alias: AGY_MODEL)
  FIRECRAWL_API_KEY   Optional — required for --web
  FIRECRAWL_API_URL   Optional — default: https://api.firecrawl.dev/v2
  TWITTER_CLI_BIN     Optional — twitter-cli binary (default: twitter); --twitter uses it read-only
  TWITTER_AUTH_TOKEN / TWITTER_CT0 — read by twitter-cli itself (burner account), never by osint-ai

  Deep-scan tuning (rarely needed):
  DEEP_MAX_ITEMS_PER_DOMAIN  Per-domain sub-agent item cap (default 180, aligned with the chunk size)
  DEEP_EXHAUSTIVE=1          No cap / no signal floor — send every surviving item to the sub-agents (slow)
`);
	process.exit(0);
}

const args = process.argv.slice(2);

if (args.includes("--init-env")) {
	ensureEnvExample();
	console.error("Created .env.local template if it did not already exist.");
	process.exit(0);
}
if (args[0] === "--help" || args[0] === "-h") usage();

loadEnvFile();

function parseArgs(argv: string[]): CliOptions {
		const parsed: CliOptions = {
			deep: false,
			web: false,
			twitter: false,
			years: 7,
			tui: false,
			listModels: false,
			json: false,
			chat: false,
			provider: undefined,
			model: undefined,
			username: "",
			subjectName: undefined,
		};

		for (let i = 0; i < argv.length; i++) {
			const arg = argv[i];
			if (arg === "--deep" || arg === "-d") parsed.deep = true;
			else if (arg === "--web" || arg === "-w") parsed.web = true;
			else if (arg === "--twitter" || arg === "-t") parsed.twitter = true;
			else if (arg === "--full" || arg === "-f") {
				// One-shot full investigation: deep + web + twitter.
				parsed.deep = true;
				parsed.web = true;
				parsed.twitter = true;
			}
			else if (arg === "--tui") parsed.tui = true;
		else if (arg === "--list-models") parsed.listModels = true;
		else if (arg === "--json" || arg === "-j") parsed.json = true;
		else if (arg === "--chat" || arg === "-c") parsed.chat = true;
		else if (arg === "--provider") {
			const next = argv[++i]?.trim().toLowerCase();
			const provider = next ? PROVIDER_ALIASES[next] : undefined;
			if (!provider) {
				throw new Error(`--provider must be 'openai', 'claude-code', 'codex-cli', 'pi', or 'antigravity' (got: ${next ?? ""}).`);
			}
			parsed.provider = provider;
		}
		else if (arg === "--model") {
			const next = argv[++i]?.trim();
			if (!next) throw new Error(`--model requires a value.`);
			parsed.model = next;
		}
		else if (arg === "--subject-name" || arg === "--target-name") {
			const next = argv[++i]?.trim();
			if (!next) throw new Error(`${arg} requires a non-empty name.`);
			parsed.subjectName = next;
		}
		else if (arg === "--years" || arg === "-y") {
			const next = argv[++i];
			const value = Number.parseInt(next ?? "", 10);
			if (!Number.isFinite(value) || value < 1 || value > 20) {
				throw new Error("--years must be a number from 1 to 20.");
			}
			parsed.years = value;
		} else if (arg.startsWith("-")) {
			throw new Error(`Unknown flag: ${arg}`);
		} else {
			parsed.username = cleanUsername(arg);
		}
	}

	return parsed;
}

function cleanUsername(value: string): string {
	return value.trim().replace(/^u\//i, "");
}

function validateUsername(username: string): void {
	if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) {
		throw new Error("Enter a valid Reddit username: 3-20 chars, letters/numbers/_/-.");
	}
}

function isYes(answer: string): boolean {
	return /^(y|yes|true|1)$/i.test(answer.trim());
}

const REPORTS_DIR = join(import.meta.dir, "..", "reports");

/**
 * Load the most recently saved report for a username (markdown or JSON) and
 * build a ChatContext from it. Used by `--chat <username>`.
 */
function loadLatestReport(username: string): ChatContext | null {
	if (!existsSync(REPORTS_DIR)) return null;
	const prefix = `report_${username}_`;
	const candidates = readdirSync(REPORTS_DIR)
		.filter((f) => f.startsWith(prefix))
		.sort()
		.reverse();
	if (candidates.length === 0) return null;

	const mdFile = candidates.find((f) => f.endsWith(".md"));
	if (mdFile) {
		const report = readFileSync(join(REPORTS_DIR, mdFile), "utf-8");
		return { username, report };
	}

	const jsonFile = candidates.find((f) => f.endsWith(".json"));
	if (jsonFile) {
		try {
			const data = JSON.parse(readFileSync(join(REPORTS_DIR, jsonFile), "utf-8"));
			return {
				username,
				report: data.content ?? JSON.stringify(data, null, 2),
				structured: data.structured,
				directIdentifiers: data.directIdentifiers,
				corroboration: data.corroboration,
			};
		} catch {
			return null;
		}
	}
	return null;
}

function resolveYes(answer: string, fallback: boolean): boolean {
	const trimmed = answer.trim();
	if (!trimmed) return fallback;
	return isYes(trimmed);
}

async function readInteractiveOptions(options: CliOptions): Promise<CliOptions> {
	if (!process.stdin.isTTY) {
		throw new Error("No username was provided and stdin is not interactive. Run with --help for usage.");
	}

	const rl = createInterface({ input, output });
	try {
		while (!options.username) {
			options.username = cleanUsername(await rl.question("Reddit username: "));
			try {
				validateUsername(options.username);
			} catch (err: any) {
				console.error(err.message);
				options.username = "";
			}
		}

		const deepAnswer = await rl.question(`Deep multi-agent scan? [${options.deep ? "Y/n" : "y/N"}] `);
		options.deep = resolveYes(deepAnswer, options.deep);
		if (options.deep) {
			const yearsAnswer = await rl.question(`Years to scan back [${options.years}]: `);
			if (yearsAnswer.trim()) {
				const years = Number.parseInt(yearsAnswer, 10);
				if (!Number.isFinite(years) || years < 1 || years > 20) {
					throw new Error("Years must be a number from 1 to 20.");
				}
				options.years = years;
			}
		}

		options.web = resolveYes(
			await rl.question(`Enable Firecrawl web enrichment? [${options.web ? "Y/n" : "y/N"}] `),
			options.web,
		);
		options.twitter = resolveYes(
			await rl.question(`Enable the Twitter/X identity pass (twitter-cli, burner account, read-only)? [${options.twitter ? "Y/n" : "y/N"}] `),
			options.twitter,
		);
		return options;
	} finally {
		rl.close();
	}
}

function elapsed(startedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
	const secs = (seconds % 60).toString().padStart(2, "0");
	return `${mins}:${secs}`;
}

function truncate(value: string, max = 220): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length > max ? `${singleLine.slice(0, max - 1)}...` : singleLine;
}

function writeLines(prefix: string, message: string): void {
	for (const rawLine of message.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line) console.log(`${prefix} ${line}`);
	}
}

async function listModels(options: CliOptions): Promise<never> {
	// --list-models only makes sense for an OpenAI-compatible endpoint.
	if (resolveProvider({ provider: options.provider }) !== "openai") {
		console.error(`--list-models requires the openai provider. Use --provider openai (and set OPENAI_API_KEY/OPENAI_BASE_URL).`);
		process.exit(1);
	}
	assertLLMConfig({ provider: options.provider });
	const { createOpenAIClient } = await import("./runtime/llm.ts");
	try {
		const models = await createOpenAIClient().models.list();
		for (const model of models.data) console.log(model.id);
		process.exit(0);
	} catch (err: any) {
		console.error(`Failed to list models: ${err.message ?? String(err)}`);
		process.exit(1);
	}
}

async function launchTui(options: CliOptions): Promise<void> {
	assertLLMConfig({ provider: options.provider });

	const [{ createCliRenderer }, { createRoot }, { App }] = await Promise.all([
		import("@opentui/core"),
		import("@opentui/react"),
		import("./tui/App.tsx"),
	]);

	const renderer = await createCliRenderer({
		exitOnCtrlC: false,
		targetFps: 30,
	});

	createRoot(renderer).render(
		<App
			initialUsername={options.username}
			initialDeep={options.deep}
			initialYears={options.years}
			initialWeb={options.web}
			initialSubjectName={options.subjectName}
			autoStart={!!options.username}
		/>,
	);
}

async function runCli(options: CliOptions): Promise<void> {
	if (!options.username) options = await readInteractiveOptions(options);
	validateUsername(options.username);
	assertLLMConfig({ provider: options.provider });

	const mode = options.deep ? `deep ${options.years}yr` : "standard";
	const extras = [
		options.web ? "Firecrawl" : null,
		options.twitter ? "Twitter" : null,
	].filter(Boolean);
	const startedAt = Date.now();
	let lastStatus = "";

	console.log("");
	console.log(`osint-ai: u/${options.username}`);
	console.log(`mode: ${mode}${extras.length ? ` + ${extras.join(" + ")}` : ""}`);
	if (options.subjectName) {
		console.log(`candidate identity: ${options.subjectName} (hypothesis to verify)`);
	}
	console.log(describeModels());
	console.log("press Ctrl+C to stop");
	console.log("");

	process.once("SIGINT", () => {
		console.error(`\n[${elapsed(startedAt)}] interrupted`);
		process.exit(130);
	});

	const callbacks: AuditCallbacks = {
		onStatus: (message) => {
			if (message !== lastStatus) {
				lastStatus = message;
				console.log(`[${elapsed(startedAt)}] status: ${message}`);
			}
		},
		onProgress: (message) => writeLines(`[${elapsed(startedAt)}]`, message),
		onToolCall: (name, args) => {
			console.log(`[${elapsed(startedAt)}] tool: ${name} ${truncate(JSON.stringify(args))}`);
		},
		onToolResult: (name, result) => {
			const size = JSON.stringify(result).length;
			console.log(`[${elapsed(startedAt)}] done: ${name} (${size.toLocaleString()} chars)`);
		},
		onToken: (text) => {
			console.log(`[${elapsed(startedAt)}] report draft received (${text.length.toLocaleString()} chars)`);
		},
	};

	try {
		const result = await runAudit(
			{
				username: options.username,
				deep: options.deep,
				years: options.years,
				web: options.web,
				twitter: options.twitter,
				dataDir: DATA_DIR,
				candidate: {
					name: options.subjectName,
				},
			},
			callbacks,
		);

		const filepath = options.json
			? saveJsonReport(options.username, result.json ?? { content: result.content })
			: saveReport(options.username, result.content);
		console.log("");
		console.log("complete");
		// Print the narrative person-brief so a result is visible immediately;
		// point to the saved file for the full detailed report.
		if (result.brief) {
			console.log("");
			console.log("── summary ────────────────────────────────────────────");
			console.log(`u/${options.username}: ${result.brief}`);
			console.log("── end summary ────────────────────────────────────────");
			console.log(`full report: ${filepath}`);
		} else {
			console.log(`report: ${filepath}`);
		}
		if (result.directIdentifiers) {
			const n = result.directIdentifiers.emails.length + result.directIdentifiers.socialHandles.length;
			if (n > 0) console.log(`direct identifiers: ${n} (${result.directIdentifiers.emails.length} emails, ${result.directIdentifiers.socialHandles.length} handles)`);
		}
		console.log(`tool calls: ${result.toolCalls}`);
		console.log(`iterations: ${result.iterations}`);
		console.log(`elapsed: ${elapsed(startedAt)}`);

		// "Chat with the verdict": offer an interactive REPL grounded in the
		// completed audit (also reachable later via --chat <username>).
		if (options.chat && process.stdin.isTTY) {
			const ctx: ChatContext = {
				username: options.username,
				report: result.content,
				structured: result.structured,
				directIdentifiers: result.directIdentifiers,
				corroboration: result.corroboration,
			};
			await startChatRepl(ctx);
		} else if (options.chat && !process.stdin.isTTY) {
			console.error("(chat requires an interactive terminal; run again with a TTY)");
		}
	} catch (err: any) {
		console.error("");
		console.error(`failed: ${err.message ?? String(err)}`);
		process.exit(1);
	}
}

let options: CliOptions;
try {
	options = parseArgs(args);
} catch (err: any) {
	console.error(err.message);
	console.error("Run `bun run src/index.tsx --help` for usage.");
	process.exit(1);
}

// Apply --provider / --model flags to the environment so every downstream
// resolveProvider()/resolveModel() call picks them up uniformly.
if (options.provider) process.env.LLM_PROVIDER = options.provider;
if (options.model) {
	const provider = resolveProvider();
	if (provider === "claude-code") process.env.CLAUDE_CODE_MODEL = options.model;
	else if (provider === "codex-cli") process.env.CODEX_CLI_MODEL = options.model;
	else if (provider === "pi") process.env.PI_MODEL = options.model;
	else if (provider === "antigravity") process.env.ANTIGRAVITY_MODEL = options.model;
	else process.env.OPENAI_MODEL = options.model;
}

try {
	if (options.listModels) await listModels(options);
	else if (options.tui) await launchTui(options);
	else if (options.chat && !options.username && !(options.deep || options.web || options.twitter)) {
		// Bare `--chat` (no scan flags, no positional) is nonsensical.
		console.error("--chat requires a username: bun run src/index.tsx --chat <username>");
		process.exit(1);
	} else if (options.chat && !(options.deep || options.web || options.twitter)) {
		// --chat <username>: chat about the latest saved report (no scan flags).
		validateUsername(options.username);
		assertLLMConfig({ provider: options.provider });
		const ctx = loadLatestReport(options.username);
		if (!ctx) {
			console.error(`No saved report found for u/${options.username} in reports/. Run a scan first (e.g. bun run src/index.tsx ${options.username}), or use --chat after a scan.`);
			process.exit(1);
		}
		await startChatRepl(ctx);
	} else await runCli(options);
} catch (err: any) {
	console.error(`\n${err.message ?? String(err)}`);
	if (String(err.message ?? "").includes("OPENAI")) {
		console.error(`Run \`bun run src/index.tsx --init-env\` to create a .env.local template.`);
	}
	process.exit(1);
}
