/**
 * Shared plumbing for the CLI-backed LLM providers.
 *
 * claude-code, codex-cli, pi, and antigravity all shell out to a local CLI
 * binary and wrap its stdout identically: spawn with piped stdio, a hard
 * timeout that kills the child, accumulate stdout/stderr, and map ENOENT and
 * non-zero exits into actionable errors. They also share the `complete()` /
 * `agentStep()` bodies (JSON guard, ReAct fence parse) and the
 * "SYSTEM INSTRUCTIONS / TASK INPUT" prompt assembly used by the CLI providers
 * that pass the prompt as a positional arg rather than a system flag.
 *
 * The only real variance — binary name, argv, env-var prefix, and what (if
 * anything) is written to stdin — is parameterized, so it lives here once
 * instead of four divergent copies that had already drifted.
 */

import { spawn } from "node:child_process";
import type {
  AgentStepParams,
  AgentStepResult,
  CompleteParams,
  LLMClient,
} from "./types.ts";
import { buildToolAddendum, parseToolCalls, renderConversation } from "./text-react.ts";

const DEFAULT_TIMEOUT_MS = 480_000;

/** Read an env var with a fallback (no trimming — callers trim when they care). */
export function env(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

/** Parse a timeout env var chain; fall back to DEFAULT_TIMEOUT_MS on garbage/≤0. */
export function readTimeoutMs(...keys: string[]): number {
  const raw = keys.map((k) => process.env[k]).find((v) => v && v.trim()) ?? String(DEFAULT_TIMEOUT_MS);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/** Assemble the system+user prompt into one positional-arg payload for CLIs
 * that take the whole prompt on the command line rather than a system flag. */
export function buildCliPrompt(systemPrompt: string, stdin: string): string {
  const sections: string[] = [];
  if (systemPrompt.trim()) {
    sections.push(`SYSTEM INSTRUCTIONS\n${systemPrompt.trim()}`);
  }
  sections.push(`TASK INPUT\n${stdin.trim()}`);
  return sections.join("\n\n---\n\n");
}

export interface CliRunOptions {
  /** Label used in error messages (e.g. "claude-code"). */
  label: string;
  bin: string;
  args: string[];
  /** Written to the child's stdin when non-null (some CLIs take the prompt via argv). */
  stdin: string | null;
  timeoutMs: number;
  /** Install/switch hint appended to the "not found in PATH" error. */
  enoentHint: string;
}

/** Run a CLI binary once; resolve with stdout, reject on timeout/ENOENT/non-zero exit. */
export function runCli(opts: CliRunOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(opts.bin, opts.args, { stdio: ["pipe", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${opts.label} request timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    timer.unref();

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error(`${opts.label} provider: '${opts.bin}' not found in PATH. ${opts.enoentHint}`));
      } else {
        reject(new Error(`${opts.label} spawn failed: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = (stderr.trim() || stdout.trim()).slice(0, 500);
        reject(new Error(`${opts.label} exited with code ${code}` + (detail ? `: ${detail}` : "")));
        return;
      }
      resolve(stdout);
    });

    if (opts.stdin !== null) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

/**
 * Shared `complete()` / `agentStep()` bodies for CLI providers. Subclasses
 * only supply `label`, `model`, and `runOnce()` (argv + stdin assembly).
 */
export abstract class CliClientBase implements LLMClient {
  abstract readonly label: string;
  abstract readonly model: string;
  readonly supportsNativeTools = false;
  protected abstract runOnce(systemPrompt: string, stdin: string): Promise<string>;

  async complete(params: CompleteParams): Promise<string> {
    const system = params.json
      ? `${params.system}\n\nOutput ONLY a valid JSON object. No prose, no code fences, no commentary.`
      : params.system;
    return this.runOnce(system, params.user);
  }

  async agentStep(params: AgentStepParams): Promise<AgentStepResult> {
    const systemMessage = params.messages.find((m) => m.role === "system");
    const system = `${systemMessage?.content ?? ""}${buildToolAddendum(params.tools)}`;
    const stdin = renderConversation(params.messages);
    const output = await this.runOnce(system, stdin);
    const { calls, rest } = parseToolCalls(output);
    return { text: rest.trim(), toolCalls: calls };
  }
}
