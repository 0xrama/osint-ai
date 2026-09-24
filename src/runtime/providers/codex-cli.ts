/**
 * Codex CLI backend.
 *
 * Shells out to `codex exec` so a run can use the operator's existing Codex
 * subscription/login instead of API credentials. It intentionally behaves like
 * the Claude Code provider: app-owned tools still flow through the text ReAct
 * fence protocol, while Codex itself runs in a read-only ephemeral sandbox by
 * default. This keeps osint-ai's deterministic Reddit and Firecrawl layers
 * in control instead of delegating the whole audit to a separate coding agent.
 *
 * Config:
 *   CODEX_CLI_BIN        path to the codex binary (default: "codex")
 *   CODEX_CLI_MODEL      model to pass via --model (default: Codex CLI config)
 *   CODEX_CLI_TIMEOUT_MS per-invocation timeout ms (default: 480000 = 8 min)
 *   CODEX_CLI_SANDBOX    read-only | workspace-write | danger-full-access
 */

import { CliClientBase, buildCliPrompt, env, readTimeoutMs, runCli } from "./cli-runner.ts";

const CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;
type CodexSandbox = (typeof CODEX_SANDBOXES)[number];

function readSandbox(): CodexSandbox {
  const value = (env("CODEX_CLI_SANDBOX", "read-only")).trim();
  if (CODEX_SANDBOXES.includes(value as CodexSandbox)) return value as CodexSandbox;
  throw new Error(
    `codex-cli provider: CODEX_CLI_SANDBOX must be one of ${CODEX_SANDBOXES.join(", ")} (got ${value}).`,
  );
}

export class CodexCliClient extends CliClientBase {
  readonly label = "codex-cli";
  readonly model: string;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(model: string) {
    super();
    this.bin = env("CODEX_CLI_BIN", "").trim() || "codex";
    this.model = model;
    this.timeoutMs = readTimeoutMs("CODEX_CLI_TIMEOUT_MS");
  }

  /** Run `codex exec` once and return the final assistant message from stdout. */
  protected runOnce(systemPrompt: string, stdin: string): Promise<string> {
    const explicitModel = env("CODEX_CLI_MODEL").trim();
    const args = ["exec", "--ephemeral", "--sandbox", readSandbox(), "--color", "never"];
    if (explicitModel) args.push("--model", explicitModel);
    args.push("-");
    const prompt = buildCliPrompt(systemPrompt, stdin);

    return runCli({
      label: this.label,
      bin: this.bin,
      args,
      stdin: prompt,
      timeoutMs: this.timeoutMs,
      enoentHint: "Install Codex CLI (https://github.com/openai/codex), run 'codex' once to authenticate, or switch providers with --provider openai / --provider claude-code.",
    });
  }
}
