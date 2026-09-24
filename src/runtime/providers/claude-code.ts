/**
 * Claude Code CLI backend.
 *
 * Shells out to `claude -p` (print / non-interactive mode) so a run uses your
 * existing Claude Code session — no API key required in the environment. This
 * is the fallback path for when you don't have (or don't want to pay for) an
 * OpenAI-compatible API: it runs entirely against your Claude subscription
 * (Claude Max, GLM via the Anthropic-compatible surface, etc.) via the
 * locally-installed `claude` binary.
 *
 * Tradeoffs vs. the OpenAI path, stated plainly:
 *   - No native function-calling. `claude -p` has no tool/function API, so the
 *     agent loop uses a text-based ReAct protocol: the model emits tool calls as
 *     fenced "tool" blocks, we parse + execute them, and feed results back.
 *   - No prompt caching, no max_tokens control.
 *   - Slower per call (CLI cold start every invocation) — the synthesis
 *     web-hunting loop spawns `claude -p` once per iteration.
 *   - The structured-findings JSON-repair fallback covers the lack of
 *     `response_format: json_object`.
 *
 * Config:
 *   CLAUDE_CODE_BIN        path to the claude binary (default: "claude")
 *   CLAUDE_CODE_MODEL      model to pass via --model (default: claude's own)
 *   CLAUDE_CODE_TIMEOUT_MS per-invocation timeout ms (default: 480000 = 8 min)
 */

import { CliClientBase, env, readTimeoutMs, runCli } from "./cli-runner.ts";
export { parseToolCalls, renderConversation } from "./text-react.ts";

export class ClaudeCodeClient extends CliClientBase {
  readonly label = "claude-code";
  readonly model: string;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(model: string) {
    super();
    this.bin = env("CLAUDE_CODE_BIN", "claude");
    this.model = model;
    this.timeoutMs = readTimeoutMs("CLAUDE_CODE_TIMEOUT_MS");
  }

  /** Run `claude -p` once and return its stdout. */
  protected runOnce(systemPrompt: string, stdin: string): Promise<string> {
    const explicitModel = env("CLAUDE_CODE_MODEL").trim();
    const args = ["-p"];
    if (explicitModel) args.push("--model", explicitModel);
    // When web research is preferred via the Firecrawl MCP server, pre-approve
    // its tools so non-interactive `claude -p` can call them without a prompt.
    if (process.env.CLAUDE_CODE_WEB_VIA_MCP !== "0") {
      args.push("--allowedTools", "mcp__firecrawl__*");
    }
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

    return runCli({
      label: this.label,
      bin: this.bin,
      args,
      stdin,
      timeoutMs: this.timeoutMs,
      enoentHint: "Install Claude Code (https://claude.com/claude-code), or switch providers (set OPENAI_API_KEY / OPENAI_BASE_URL, or pass --provider openai).",
    });
  }
}
