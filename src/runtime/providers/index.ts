/**
 * Provider resolution + factory + config validation.
 *
 * resolveProvider(): which backend to use.
 *   explicit --provider/LLM_PROVIDER flag wins, then auto-detect from env:
 *     - OPENAI_API_KEY / OPENAI_BASE_URL present ⇒ openai
 *     - otherwise ⇒ claude-code (so the tool still runs out-of-the-box when
 *       no API is configured). codex-cli is opt-in because there is no safe
 *       credential env to auto-detect; set LLM_PROVIDER=codex-cli or pass
 *       --provider codex-cli to use the local Codex subscription/login.
 *
 * assertLLMConfig(): validates the chosen backend's requirements. For openai
 * that means credentials + base URL; for CLI providers nothing is required
 * here (the binary is checked at spawn time).
 *
 * NOTE: this module imports only ./types, ./openai, CLI providers, and
 * ../config (runtimeConfig). It must NOT import config/models — that would
 * create an import cycle (models.ts imports resolveProvider from here).
 */

import OpenAI from "openai";
import { runtimeConfig } from "../config.ts";
import { isFirecrawlConfigured } from "../firecrawl.ts";
import { OpenAILLMClient } from "./openai.ts";
import { ClaudeCodeClient } from "./claude-code.ts";
import { CodexCliClient } from "./codex-cli.ts";
import { PiClient } from "./pi.ts";
import { AntigravityClient } from "./antigravity.ts";
import type { LLMClient, Provider } from "./types.ts";

export type { Provider, LLMClient, LLMMessage, ToolCall, CompleteParams, AgentStepParams, AgentStepResult } from "./types.ts";

function normalizeProvider(value: string): Provider {
  const p = value.trim().toLowerCase();
  if (
    p === "openai" ||
    p === "claude-code" ||
    p === "claudecode" ||
    p === "claude" ||
    p === "codex-cli" ||
    p === "codexcli" ||
    p === "codex" ||
    p === "pi" ||
    p === "antigravity" ||
    p === "antigrav" ||
    p === "agy"
  ) {
    if (p === "claudecode" || p === "claude") return "claude-code";
    if (p === "codexcli" || p === "codex") return "codex-cli";
    if (p === "antigrav" || p === "agy") return "antigravity";
    return p as Provider;
  }
  throw new Error(
    `Unknown LLM provider "${value}". Use "openai", "claude-code", "codex-cli", "pi", or "antigravity".`,
  );
}

/**
 * Resolve the active provider. `overrides.provider` (from --provider) wins,
 * then LLM_PROVIDER env, then auto-detect from credentials.
 */
export function resolveProvider(overrides: { provider?: string } = {}): Provider {
  const explicit = overrides.provider ?? process.env.LLM_PROVIDER;
  if (explicit) return normalizeProvider(explicit);

  if (process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) return "openai";

  // No API credentials present → fall back to the Claude Code CLI session.
  return "claude-code";
}

let cachedClient: LLMClient | null = null;
let cachedProvider: Provider | null = null;

/**
 * True when web research should go through the Firecrawl MCP server (claude-code
 * backend) instead of our own ReAct web tools. The Codex CLI backend keeps web
 * research in the app-owned ReAct tools for reproducibility.
 */
export function mcpWebPreferred(): boolean {
  if (resolveProvider() !== "claude-code") return false;
  return process.env.CLAUDE_CODE_WEB_VIA_MCP !== "0";
}

/**
 * Whether web research is available in the current run. For claude-code this is
 * the Firecrawl MCP server (no API key needed); for openai and codex-cli it's
 * our own Firecrawl client (self-hosted URL or cloud key).
 */
export function webToolsAvailable(web: boolean): boolean {
  if (!web) return false;
  if (resolveProvider() === "claude-code") return mcpWebPreferred();
  return isFirecrawlConfigured();
}

/**
 * System-prompt note telling a claude-code model to use the Firecrawl MCP tools
 * available natively in its environment. Empty on openai and codex-cli paths.
 */
export function mcpWebNote(): string {
  if (!mcpWebPreferred()) return "";
  return [
    "",
    "WEB RESEARCH (via MCP)",
    "Firecrawl web tools are available NATIVELY in your environment via MCP:",
    "  - firecrawl_search: search the web (returns titles, URLs, descriptions)",
    "  - firecrawl_scrape: read a specific URL as clean markdown",
    "  - firecrawl_crawl: follow a site and read its pages",
    "These execute automatically — no permission needed, no fences required. Use them aggressively and iteratively to hunt the subject's cross-platform identities (search the username in quotes, scrape promising profiles, cross-reference against Reddit markers).",
    "",
  ].join("\n");
}

/**
 * Get the active LLM client (memoized). Re-resolves if the provider changes
 * between calls (e.g. flags set process.env.LLM_PROVIDER after first call).
 */
export function getLLMClient(overrides: { provider?: string } = {}): LLMClient {
  const provider = resolveProvider(overrides);
  if (cachedClient && cachedProvider === provider) return cachedClient;

  if (provider === "openai") {
    const { apiKey, baseURL } = runtimeConfig.llm;
    const sdk = new OpenAI({ apiKey, baseURL });
    cachedClient = new OpenAILLMClient(sdk, process.env.OPENAI_MODEL?.trim() || "(role-based)");
  } else if (provider === "claude-code") {
    cachedClient = new ClaudeCodeClient("(claude-code default)");
  } else if (provider === "codex-cli") {
    cachedClient = new CodexCliClient("(codex-cli default)");
  } else if (provider === "pi") {
    cachedClient = new PiClient("(pi default)");
  } else {
    cachedClient = new AntigravityClient("(antigravity default)");
  }
  cachedProvider = provider;
  return cachedClient;
}

/**
 * Validate runtime config for the active provider. Throws a helpful message
 * explaining how to fix it when something is missing.
 */
export function assertLLMConfig(overrides: { provider?: string } = {}): void {
  const provider = resolveProvider(overrides);
  if (
    provider === "claude-code" ||
    provider === "codex-cli" ||
    provider === "pi" ||
    provider === "antigravity"
  ) {
    // No API credentials required; the CLI binary is checked at spawn time.
    return;
  }
  const missing: string[] = [];
  if (!runtimeConfig.llm.apiKey) missing.push("OPENAI_API_KEY");
  if (!runtimeConfig.llm.baseURL) missing.push("OPENAI_BASE_URL");
  if (missing.length > 0) {
    throw new Error(
      `Missing OpenAI-compatible runtime config: ${missing.join(", ")}. ` +
        `Edit .env.local / export the vars, OR switch to a CLI backend (pass --provider claude-code, --provider codex-cli, --provider pi, or --provider antigravity).`,
    );
  }
}
