import { describe, expect, test } from "bun:test";
import { parseToolCalls, renderConversation } from "./claude-code.ts";
import { buildToolAddendum } from "./text-react.ts";
import type { ToolDefinition } from "../types.ts";
import type { LLMMessage } from "./types.ts";

describe("claude-code ReAct helpers", () => {
  test("parses multiple tool fences and removes them from prose", () => {
    const parsed = parseToolCalls([
      "I need data.",
      "```tool",
      '{"name":"reddit_search","args":{"username":"alice","deep":true}}',
      "```",
      "```tool",
      '{"name":"web_search","arguments":"{\\\"query\\\":\\\"alice github\\\"}"}',
      "```",
      "Waiting.",
    ].join("\n"));

    expect(parsed.calls).toHaveLength(2);
    expect(parsed.calls[0]).toMatchObject({ name: "reddit_search", args: { username: "alice", deep: true } });
    expect(parsed.calls[1]).toMatchObject({ name: "web_search", args: { query: "alice github" } });
    expect(parsed.rest).toContain("I need data.");
    expect(parsed.rest).toContain("Waiting.");
    expect(parsed.rest).not.toContain("```tool");
  });

  test("leaves malformed tool fences as prose", () => {
    const parsed = parseToolCalls("```tool\nnot json\n```");
    expect(parsed.calls).toEqual([]);
    expect(parsed.rest).toContain("not json");
  });

  test("renderConversation excludes system messages and includes tool results", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "hidden" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "calling" },
      { role: "tool", name: "reddit_search", toolCallId: "1", content: "{\"ok\":true}" },
    ];
    const rendered = renderConversation(messages);
    expect(rendered).not.toContain("hidden");
    expect(rendered).toContain("=== USER ===\nhello");
    expect(rendered).toContain("=== TOOL RESULT (reddit_search) ===");
    expect(rendered).toContain("FINAL answer");
  });

  test("renders the shared text ReAct tool contract with required arguments", () => {
    const tools: ToolDefinition<Readonly<Record<string, unknown>>, { ok: true }>[] = [
      {
        name: "reddit_search",
        description: "Search Reddit comments",
        parameters: {
          type: "object",
          required: ["username"],
          properties: {
            username: { type: "string", description: "Reddit username" },
            after: { type: "string", description: "Pagination cursor" },
          },
        },
        execute: async () => ({ ok: true }),
      },
    ];

    const addendum = buildToolAddendum(tools);

    expect(addendum).toContain("Output a fenced code block with the language tag `tool`");
    expect(addendum).toContain('\"name\": \"reddit_search\"');
    expect(addendum).toContain('\"username\" (string, required) — Reddit username');
    expect(addendum).toContain('\"after\" (string, optional) — Pagination cursor');
    expect(addendum).toContain("After your tool block(s), STOP immediately.");
  });
});
