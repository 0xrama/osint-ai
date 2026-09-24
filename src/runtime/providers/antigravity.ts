/**
 * Antigravity CLI (agy) backend.
 *
 * Shells out to `agy -p` (print / non-interactive mode) so a run can use the
 * operator's active Antigravity session and configured models (Gemini, Claude,
 * GPT, etc.) without needing an external API key.
 *
 * Like the Claude Code, Codex CLI, and Pi providers:
 *   - Uses the shared text-based ReAct fence protocol for app-owned tools
 *     (reddit_search, web_search, web_scrape, web_follow_site).
 *   - Runs with `--dangerously-skip-permissions` and `--disable-slash-commands`
 *     to prevent permission prompts or accidental slash command expansion in
 *     non-interactive mode.
 *
 * Config:
 *   ANTIGRAVITY_BIN / AGY_BIN        path to the agy binary (default: "agy")
 *   ANTIGRAVITY_MODEL / AGY_MODEL    model to pass via --model (e.g. "Gemini 3.6 Flash (High)", "Gemini 3.7 Pro")
 *   ANTIGRAVITY_EFFORT / AGY_EFFORT  reasoning effort to pass via --effort (low|medium|high)
 *   ANTIGRAVITY_TIMEOUT_MS           per-invocation timeout ms (default: 480000 = 8 min)
 */

import { CliClientBase, buildCliPrompt, env, readTimeoutMs, runCli } from "./cli-runner.ts";

export class AntigravityClient extends CliClientBase {
  readonly label = "antigravity";
  readonly model: string;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(model: string) {
    super();
    this.bin = env("ANTIGRAVITY_BIN", env("AGY_BIN", "agy")).trim() || "agy";
    this.model = model;
    this.timeoutMs = readTimeoutMs("ANTIGRAVITY_TIMEOUT_MS", "AGY_TIMEOUT_MS");
  }

  /** Run `agy -p` once and return its stdout. */
  protected runOnce(systemPrompt: string, stdin: string): Promise<string> {
    const explicitModel = env("ANTIGRAVITY_MODEL", env("AGY_MODEL")).trim();
    const explicitEffort = env("ANTIGRAVITY_EFFORT", env("AGY_EFFORT")).trim();

    const args = [
      "--dangerously-skip-permissions",
      "--disable-slash-commands",
      "-p",
    ];

    if (explicitModel) args.push("--model", explicitModel);
    if (explicitEffort) args.push("--effort", explicitEffort);

    const prompt = buildCliPrompt(systemPrompt, stdin);

    // `agy -p <prompt>` (positional arg) is the reliable path. agy -p - (stdin)
    // intermittently returns a generic greeting instead of answering, so only
    // fall back to stdin when the prompt exceeds the OS argv limit (~256KB).
    const viaStdin = prompt.length > 200_000;
    if (!viaStdin) args.push(prompt);
    else args.push("-");

    return runCli({
      label: this.label,
      bin: this.bin,
      args,
      stdin: viaStdin ? prompt : null,
      timeoutMs: this.timeoutMs,
      enoentHint: "Ensure Antigravity CLI ('agy') is installed, or switch providers with --provider claude-code / --provider openai / --provider pi / --provider codex-cli.",
    });
  }
}
