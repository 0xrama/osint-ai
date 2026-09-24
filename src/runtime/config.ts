import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const ENV_PATH = resolve(ROOT, ".env.local");

function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

export function loadEnvFile(path = ENV_PATH): void {
	if (!existsSync(path)) return;
	const parsed = parseEnvFile(readFileSync(path, "utf-8"));
	for (const [key, value] of Object.entries(parsed)) {
		if (value !== "" && process.env[key] === undefined) process.env[key] = value;
	}
}

export function ensureEnvExample(): void {
	if (existsSync(ENV_PATH) && statSync(ENV_PATH).size > 0) return;
	const body = [
		"# osint-ai runtime config",
		"",
		"# ── LLM provider ──────────────────────────────────────────────",
		"# Five interchangeable backends. Auto-detect picks openai if any",
		"# OPENAI_* var is set, otherwise falls back to the Claude Code CLI.",
		"# Force one with: LLM_PROVIDER=openai | claude-code | codex-cli | pi | antigravity",
		"LLM_PROVIDER=",
		"",
		"# OpenAI-compatible API (OpenAI, Fireworks, Gemini, Ollama, Groq, …)",
		"# For Fireworks: OPENAI_BASE_URL=https://api.fireworks.ai/inference/v1",
		"OPENAI_API_KEY=",
		"OPENAI_BASE_URL=https://api.openai.com/v1",
		"OPENAI_MODEL=",
		"# Leave OPENAI_MODEL blank to use the role split in src/config/models.ts:",
		"#   subagent deepseek-v4-flash · synthesis deepseek-v4-pro",
		"",
		"# Claude Code CLI backend (uses your local claude session)",
		"CLAUDE_CODE_BIN=claude",
		"CLAUDE_CODE_MODEL=",
		"CLAUDE_CODE_TIMEOUT_MS=480000",
		"",
		"# Codex CLI backend (uses your local codex subscription/login)",
		"CODEX_CLI_BIN=codex",
		"CODEX_CLI_MODEL=",
		"CODEX_CLI_TIMEOUT_MS=480000",
		"CODEX_CLI_SANDBOX=read-only",
		"",
		"# Pi CLI backend (uses your local pi coding agent session/auth)",
		"PI_BIN=pi",
		"PI_MODEL=",
		"PI_PROVIDER=",
		"PI_THINKING=",
		"PI_TIMEOUT_MS=480000",
		"",
		"# Antigravity CLI backend (uses your local agy session/auth)",
		"ANTIGRAVITY_BIN=agy",
		"ANTIGRAVITY_MODEL=",
		"ANTIGRAVITY_EFFORT=",
		"ANTIGRAVITY_TIMEOUT_MS=480000",
		"",
		"# ── Optional enrichment ──────────────────────────────────────",
		"# Firecrawl search/scrape tools",
		"FIRECRAWL_API_KEY=",
		"FIRECRAWL_API_URL=https://api.firecrawl.dev/v2",
		"# FIRECRAWL_BASE_URL is also accepted as an alias for FIRECRAWL_API_URL",
		"# GitHub identity pass: unauthenticated works (60 req/h); a token raises it",
		"GITHUB_TOKEN=",
		"# Twitter/X identity pass (--twitter): binary of the twitter-cli tool",
		"# (uv tool install twitter-cli). osint-ai invokes it READ-ONLY",
		"# (user/following/user-posts/status only — write subcommands are refused).",
		"TWITTER_CLI_BIN=twitter",
		"# twitter-cli's own auth (burner account) — read by twitter-cli, never by us:",
		"#   TWITTER_AUTH_TOKEN + TWITTER_CT0 env vars, or browser cookie extraction.",
	].join("\n");
	writeFileSync(ENV_PATH, body + "\n");
}

function env(key: string, fallback = ""): string {
	return process.env[key] ?? fallback;
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/(chat\/completions|completions|responses|embeddings)\/?$/i, "").replace(/\/$/, "");
}

export const runtimeConfig = {
	get llm() {
		return {
			apiKey: env("OPENAI_API_KEY"),
			baseURL: normalizeBaseUrl(env("OPENAI_BASE_URL", "https://api.openai.com/v1")),
		};
	},
	get firecrawl() {
		return {
			apiKey: env("FIRECRAWL_API_KEY"),
			apiUrl: normalizeBaseUrl(env("FIRECRAWL_API_URL", env("FIRECRAWL_BASE_URL", "https://api.firecrawl.dev/v2"))),
		};
	},
};

// Runtime config validation lives in ./providers/index.ts (assertLLMConfig),
// because it must be provider-aware (CLI providers need no API credentials).
