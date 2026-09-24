/**
 * Provider-agnostic LLM abstraction.
 *
 * Five interchangeable backends:
 *   - "openai"      — any OpenAI-compatible endpoint (OpenAI, Fireworks, Gemini,
 *                     Ollama, Groq, …). Native function-calling for the agent loop.
 *   - "claude-code" — shells out to `claude -p` so the run uses your existing
 *                     Claude Code session. Uses a text-based ReAct tool loop.
 *   - "codex-cli"   — shells out to `codex exec` so the run uses your existing
 *                     Codex CLI subscription/login. Uses the same ReAct loop.
 *   - "pi"          — shells out to `pi -p` so the run uses your existing
 *                     Pi coding agent session/auth. Uses the same ReAct loop.
 *   - "antigravity" — shells out to `agy -p` so the run uses your existing
 *                     Antigravity session. Uses the same ReAct loop.
 *
 * The caller resolves the model id (via config/models.ts) and passes it in, so
 * provider clients never import the model registry — keeping the dependency
 * graph acyclic (models.ts → providers → config.ts).
 */

import type { ToolDefinition } from "../types.ts";

export type Provider = "openai" | "claude-code" | "codex-cli" | "pi" | "antigravity";

/** A normalized tool invocation. `id` echoes the OpenAI tool_call_id and is
 * synthetic for text-based providers. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

/** Normalized conversation message used by the agent loop. */
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Assistant turns that requested tools. */
  toolCalls?: ToolCall[];
  /** Tool turns: which tool produced this content. */
  toolCallId?: string;
  name?: string;
}

export interface CompleteParams {
  system: string;
  user: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Request a JSON-object response where the provider supports it. */
  json?: boolean;
}

export interface AgentStepParams {
  model: string;
  messages: LLMMessage[];
  tools: ToolDefinition[];
  temperature?: number;
}

export interface AgentStepResult {
  /** Assistant prose for this step (tool fences stripped on text providers). */
  text: string;
  /** Tool calls the model requested this step. Empty ⇒ final answer. */
  toolCalls: ToolCall[];
}

export interface LLMClient {
  readonly label: string;
  readonly model: string;
  /** True when the provider speaks native function-calling (OpenAI shape). */
  readonly supportsNativeTools: boolean;
  /** One-shot completion — sub-agents, consolidation, structured extraction. */
  complete(params: CompleteParams): Promise<string>;
  /** One step of the agent loop. */
  agentStep(params: AgentStepParams): Promise<AgentStepResult>;
}
