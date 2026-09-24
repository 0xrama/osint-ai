/**
 * Tool-calling agent loop — provider-agnostic.
 *
 * Routes through the active provider (see ./providers):
 *   - openai      → native function-calling (parallel tool calls, with a
 *                  parallel_tool_calls fallback for picky providers).
 *   - CLI providers (claude-code, codex-cli, pi, antigravity) → text-based ReAct loop (the model
 *                  emits ```tool fences, we parse + execute, feed results back).
 *
 * Used by:
 *   - the standard live audit path (reddit_search / web_search / …)
 *   - the deep-analysis synthesis step (web_search / web_scrape / web_follow_site)
 *
 * Deep multi-agent sub-agent calls (no tools) use promptOnce, not this loop.
 */

import { getLLMClient } from "./providers/index.ts";
import { resolveModel } from "../config/models.ts";
import type { AgentRunOptions, AgentRunResult } from "./types.ts";
import type { LLMMessage } from "./providers/index.ts";

export async function runAgentWithTools(options: AgentRunOptions): Promise<AgentRunResult> {
  const client = getLLMClient();
  // The live agent produces the full report in standard mode, so it runs on
  // the synthesis (strong) model.
  const model = options.model ?? resolveModel("synthesis");
  const tools = options.tools ?? [];
  const callbacks = options.callbacks ?? {};
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const maxIterations = options.maxIterations ?? 10;

  const messages: LLMMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.userPrompt },
  ];

  let iterations = 0;
  let toolCalls = 0;

  while (iterations < maxIterations) {
    iterations++;
    const step = await client.agentStep({
      model,
      messages,
      tools,
      temperature: options.temperature,
    });

    if (step.toolCalls.length > 0) {
      // Record the assistant's tool-requesting turn, then execute each tool.
      messages.push({
        role: "assistant",
        content: step.text,
        toolCalls: step.toolCalls,
      });

      const results = await Promise.all(step.toolCalls.map(async (call) => {
        const tool = toolMap.get(call.name);
        callbacks.onToolCall?.(call.name, call.args);
        toolCalls++;

        if (!tool) {
          const result = { error: `Unknown tool: ${call.name}` };
          callbacks.onToolResult?.(call.name, result);
          return { toolCallId: call.id, name: call.name, content: JSON.stringify(result) };
        }

        try {
          const result = await tool.execute(call.args);
          callbacks.onToolResult?.(call.name, result);
          return { toolCallId: call.id, name: call.name, content: JSON.stringify(result) };
        } catch (err: any) {
          const result = { error: err?.message ?? String(err) };
          callbacks.onToolResult?.(call.name, result);
          return { toolCallId: call.id, name: call.name, content: JSON.stringify(result) };
        }
      }));

      for (const result of results) {
        messages.push({
          role: "tool",
          toolCallId: result.toolCallId,
          name: result.name,
          content: result.content,
        });
      }
      continue;
    }

    // No tool calls ⇒ final answer.
    const finalText = step.text;
    if (finalText) {
      callbacks.onToken?.(finalText);
      return { text: finalText, iterations, toolCalls };
    }

    callbacks.onLog?.("Provider returned an empty assistant message; stopping.");
    return { text: "", iterations, toolCalls };
  }

  throw new Error(`Agent exceeded max iterations (${maxIterations}).`);
}
