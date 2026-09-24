/**
 * OpenAI-compatible backend. Wraps the official SDK. Used for OpenAI, Fireworks,
 * Gemini (OpenAI surface), Ollama, Groq, Together, etc. — anything speaking
 * Chat Completions.
 *
 * Owns native function-calling for the agent loop (including the
 * parallel_tool_calls fallback for providers that reject it).
 */

import type OpenAI from "openai";
import type {
  AgentStepParams,
  AgentStepResult,
  CompleteParams,
  LLMClient,
  LLMMessage,
  ToolCall,
} from "./types.ts";
import type { ToolDefinition } from "../types.ts";

/** Extract plain text from an OpenAI chat-completion content field. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

function toOpenAITools(tools: ToolDefinition[]): any[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function toOpenAIMessages(messages: LLMMessage[]): any[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

export class OpenAILLMClient implements LLMClient {
  readonly label = "openai";
  readonly model: string;
  readonly supportsNativeTools = true;
  private readonly client: OpenAI;

  constructor(client: OpenAI, model: string) {
    this.client = client;
    this.model = model;
  }

  private async createCompletion(request: any): Promise<any> {
    try {
      return await this.client.chat.completions.create(request);
    } catch (err: any) {
      const message = String(err?.message ?? "");
      // Some OpenAI-compatible providers reject optional OpenAI-only fields.
      // Retry without the offending field instead of aborting the whole run.
      if ("parallel_tool_calls" in request && /parallel_tool_calls|unsupported|unknown|unrecognized|invalid/i.test(message)) {
        const { parallel_tool_calls: _parallel, ...withoutParallel } = request;
        return await this.client.chat.completions.create(withoutParallel);
      }
      if ("response_format" in request && /response_format|json_object|unsupported|unknown|unrecognized|invalid/i.test(message)) {
        const { response_format: _responseFormat, ...withoutResponseFormat } = request;
        return await this.client.chat.completions.create(withoutResponseFormat);
      }
      throw err;
    }
  }

  async complete(params: CompleteParams): Promise<string> {
    const request: any = {
      model: params.model,
      temperature: params.temperature ?? 0.4,
      ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
    };
    if (params.json) request.response_format = { type: "json_object" };
    const response = await this.createCompletion(request);
    return extractText(response.choices[0]?.message?.content);
  }

  async agentStep(params: AgentStepParams): Promise<AgentStepResult> {
    const request: any = {
      model: params.model,
      temperature: params.temperature,
      messages: toOpenAIMessages(params.messages),
      tools: params.tools.length > 0 ? toOpenAITools(params.tools) : undefined,
      parallel_tool_calls: params.tools.length > 0 ? true : undefined,
      stream: false,
    };

    const response = await this.createCompletion(request);
    const msg = response.choices[0]?.message;
    const rawToolCalls = msg?.tool_calls ?? [];

    const toolCalls: ToolCall[] = rawToolCalls.map((call: any) => {
      const name = call.function?.name;
      let args: Record<string, any> = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = { raw_arguments: call.function?.arguments ?? "" };
      }
      return { id: call.id ?? `${name}-${Math.random()}`, name, args };
    });

    const text = extractText(msg?.content);

    // Some providers return an empty assistant message with no tool calls.
    // Retry once without tools to coax out a final answer (matches old behavior).
    if (toolCalls.length === 0 && !text) {
      const fallback = await this.createCompletion({
        model: params.model,
        messages: toOpenAIMessages(params.messages),
        stream: false,
      });
      return { text: extractText(fallback.choices[0]?.message?.content), toolCalls: [] };
    }

    return { text, toolCalls };
  }
}
