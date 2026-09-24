/**
 * Shared text-based ReAct helpers for CLI-backed providers.
 *
 * Claude Code and Codex CLI do not expose the same native function-calling
 * surface as the OpenAI-compatible backend, so both use a strict fenced JSON
 * protocol for app-owned tools. Keeping the parser shared prevents the two CLI
 * providers from drifting on the most failure-prone boundary.
 */

import type { ToolDefinition } from "../types.ts";
import type { LLMMessage, ToolCall } from "./types.ts";

const TOOL_FENCE_RE = /```tool\s*([\s\S]*?)```/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Render the available tools as a compact spec the model can act on. */
export function renderToolSpec(tools: ToolDefinition[]): string {
  const lines: string[] = [];
  for (const tool of tools) {
    const parameters = isRecord(tool.parameters) ? tool.parameters : {};
    const properties = isRecord(parameters.properties) ? parameters.properties : {};
    const required = stringArrayField(parameters, "required");
    const argSpec = Object.entries(properties)
      .map(([name, rawSchema]) => {
        const schema = isRecord(rawSchema) ? rawSchema : {};
        const req = required.includes(name) ? "required" : "optional";
        const type = stringField(schema, "type") ?? "unknown";
        const description = stringField(schema, "description");
        const desc = description ? ` — ${description}` : "";
        return `    "${name}" (${type}, ${req})${desc}`;
      })
      .join("\n");
    lines.push(`- ${tool.name}: ${tool.description}`);
    if (argSpec) lines.push(argSpec);
  }
  return lines.join("\n");
}

/**
 * System-prompt addendum teaching text-only providers the app tool protocol.
 *
 * The wording is intentionally forceful: the common failure mode is an agent
 * narrating a tool result before the app has actually executed the tool.
 */
export function buildToolAddendum(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "";
  const example = tools[0];
  const parameters = isRecord(example.parameters) ? example.parameters : {};
  const properties = isRecord(parameters.properties) ? parameters.properties : {};
  const exArg = Object.keys(properties)[0] ?? "query";
  return [
    "",
    "",
    "=== TOOL USE PROTOCOL (READ CAREFULLY — THIS OVERRIDES YOUR DEFAULTS) ===",
    "",
    "You have tools available. You CANNOT know the result of a tool until the system runs it and returns it to you. Therefore:",
    "  - You must NEVER state, quote, guess, or narrate a tool's output before calling it.",
    "  - Never write things like 'the tool returned X' unless you actually emitted a tool call and received X back.",
    "",
    "HOW TO CALL A TOOL",
    "Output a fenced code block with the language tag `tool`, containing one JSON object with `name` and `args`:",
    "",
    "```tool",
    `{"name": "${example.name}", "args": {"${exArg}": "..."}}`,
    "```",
    "",
    "RULES",
    "1. Each ```tool block is ONE call. You may emit several blocks in one turn.",
    "2. The ONLY valid contents of a tool block is JSON: {\"name\": ..., \"args\": {...}}. No prose, no comments.",
    "3. Only call a tool from the list below, with the documented argument names.",
    "4. After your tool block(s), STOP immediately. Do not answer yet. Say only something like 'Calling tool, waiting for result.' The system will execute the tools and send back their results, then you continue.",
    "5. When you have all the information you need, write your FINAL answer as normal prose with NO ```tool block.",
    "6. Never invent tool results. Never claim to have run a tool you did not call.",
    "",
    "AVAILABLE TOOLS",
    renderToolSpec(tools),
  ].join("\n");
}

/**
 * Parse ```tool fences out of model output. Tolerates either `args` or
 * `arguments`, and string-encoded argument objects.
 */
export function parseToolCalls(text: string): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  TOOL_FENCE_RE.lastIndex = 0;
  let i = 0;
  const cleaned = text.replace(TOOL_FENCE_RE, (full: string, body: string) => {
    try {
      const parsed: unknown = JSON.parse(body.trim());
      if (!isRecord(parsed)) return full;
      const name = stringField(parsed, "name")?.trim() ?? "";
      if (!name) return full;
      let args: unknown = parsed.args ?? parsed.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args) as unknown;
        } catch {
          args = { raw_arguments: args };
        }
      }
      calls.push({
        id: `call_${name}_${i++}`,
        name,
        args: isRecord(args) ? args : { value: args },
      });
      return "";
    } catch {
      return full;
    }
  });
  return { calls, rest: cleaned };
}

/** Render the full conversation as the stdin payload for text providers. */
export function renderConversation(messages: LLMMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push(`=== USER ===\n${m.content}`);
    } else if (m.role === "assistant") {
      out.push(`=== ASSISTANT ===\n${m.content}`);
    } else if (m.role === "tool") {
      out.push(`=== TOOL RESULT (${m.name ?? "tool"}) ===\n${m.content}`);
    }
  }
  out.push("=== USER ===\nIf you still need information, call a tool now (emit a ```tool block). If you have enough, write your FINAL answer as prose with NO tool block.");
  return out.join("\n\n");
}
