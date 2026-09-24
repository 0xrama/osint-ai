/**
 * Centralized LLM helpers.
 *
 * promptOnce() is the one-shot entry point used by deep-analysis sub-agents,
 * consolidation, and structured-findings extraction. It routes through the
 * active provider (OpenAI-compatible API, Claude Code CLI, or Codex CLI) — see
 * ./providers.
 *
 * The tool-calling agent loop lives in ./agent.ts and also routes through the
 * provider layer (native function-calling for openai, ReAct text loop for CLI
 * providers).
 *
 * createOpenAIClient() is kept as a low-level escape hatch for --list-models
 * (an OpenAI-specific diagnostic); the runtime path does not use it.
 */

import OpenAI from "openai";
import { runtimeConfig } from "./config.ts";
import { getLLMClient } from "./providers/index.ts";
import { resolveModel, type ModelRole } from "../config/models.ts";

/** Low-level OpenAI SDK client, for diagnostics only (--list-models). */
export function createOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: runtimeConfig.llm.apiKey,
    baseURL: runtimeConfig.llm.baseURL,
  });
}

export interface PromptOptions {
  temperature?: number;
  maxTokens?: number;
  role?: ModelRole;
  /** Request a JSON-object response where the provider supports it. */
  json?: boolean;
}

/**
 * One-shot system/user prompt. Routes to the active provider — API, Claude
 * Code CLI, or Codex CLI.
 */
export async function promptOnce(
  systemPrompt: string,
  userPrompt: string,
  options: PromptOptions = {},
): Promise<string> {
  const client = getLLMClient();
  return client.complete({
    system: systemPrompt,
    user: userPrompt,
    model: resolveModel(options.role ?? "subagent"),
    temperature: options.temperature ?? 0.4,
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    ...(options.json ? { json: true } : {}),
  });
}
