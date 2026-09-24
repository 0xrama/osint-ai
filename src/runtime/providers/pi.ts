/**
 * Pi CLI backend.
 *
 * Shells out to `pi -p` (print / non-interactive mode) so a run can use the
 * operator's existing Pi coding agent setup (configured providers, models,
 * and auth) without needing an OpenAI-compatible API key configured directly.
 *
 * Like the Claude Code and Codex CLI providers:
 *   - Uses the shared text-based ReAct fence protocol for app-owned tools
 *     (reddit_search, web_search, web_scrape, web_follow_site).
 *   - Runs with `--no-session`, `--no-tools`, and `--no-context-files` to keep
 *     osint-ai's deterministic pipeline and ReAct agent loop in full control
 *     without Pi injecting unrelated project context or executing its own tools.
 *
 * Config:
 *   PI_BIN          path to the pi binary (default: "pi")
 *   PI_MODEL        model pattern/id to pass via --model (e.g. "google/gemini-3.6-flash")
 *   PI_PROVIDER     provider name to pass via --provider (e.g. "google", "commandcode")
 *   PI_THINKING     thinking level to pass via --thinking (off|minimal|low|medium|high|xhigh|max)
 *   PI_TIMEOUT_MS   per-invocation timeout ms (default: 480000 = 8 min)
 */

import { CliClientBase, env, readTimeoutMs, runCli } from "./cli-runner.ts";

export class PiClient extends CliClientBase {
  readonly label = "pi";
  readonly model: string;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(model: string) {
    super();
    this.bin = env("PI_BIN", "pi").trim() || "pi";
    this.model = model;
    this.timeoutMs = readTimeoutMs("PI_TIMEOUT_MS");
  }

  /** Run `pi -p` once and return its stdout. */
  protected runOnce(systemPrompt: string, stdin: string): Promise<string> {
    const explicitModel = env("PI_MODEL").trim();
    const explicitProvider = env("PI_PROVIDER").trim();
    const explicitThinking = env("PI_THINKING").trim();

    const args = [
      "-p",
      "--no-session",
      "--no-tools",
      "--no-context-files",
    ];

    if (explicitModel) args.push("--model", explicitModel);
    if (explicitProvider) args.push("--provider", explicitProvider);
    if (explicitThinking) args.push("--thinking", explicitThinking);
    if (systemPrompt.trim()) args.push("--append-system-prompt", systemPrompt.trim());

    return runCli({
      label: this.label,
      bin: this.bin,
      args,
      stdin,
      timeoutMs: this.timeoutMs,
      enoentHint: "Install Pi (e.g. npm i -g @earendil-works/pi-coding-agent or bun add -g @earendil-works/pi-coding-agent), or switch providers with --provider claude-code / --provider openai / --provider antigravity / --provider codex-cli.",
    });
  }
}
