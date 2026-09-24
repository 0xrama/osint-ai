/**
 * Centralized model management.
 *
 * EVERY LLM call in the app resolves its model through this module, so the
 * whole tool can be re-targeted from a single place (here) or a single env
 * var (`OPENAI_MODEL`).
 *
 * Role tiers (tune these to re-target the whole app):
 *   subagent  — deep-analysis domain sub-agents + chunk consolidation.
 *               The grunt work of finding the actual information. Cheap/fast.
 *   synthesis — the main final analysis: deep-mode synthesis agent AND the
 *               standard live agent (which produces the full report in one shot).
 *   ranking   — reserved tier (currently unused; previously the web-intel
 *               candidate-ranking pass, now handled inside the agents).
 *
 * Default split: gpt-5.4-mini for the sub-agent grunt work, gpt-5.5 for the
 * high-value synthesis and ranking steps. Override every role at once with
 * the OPENAI_MODEL env var, or edit MODEL_REGISTRY below to split differently.
 */

import { resolveProvider } from "../runtime/providers/index.ts";

export type ModelRole = "subagent" | "synthesis" | "ranking";

export const DEFAULT_SUBAGENT_MODEL = "deepseek-v4-flash";
export const DEFAULT_STRONG_MODEL = "deepseek-v4-pro";

/** Default display model for the Claude Code CLI backend when CLAUDE_CODE_MODEL is unset. */
export const DEFAULT_CLAUDE_CODE_MODEL = "sonnet";

/** Default display model for Codex CLI when CODEX_CLI_MODEL is unset. */
export const DEFAULT_CODEX_CLI_MODEL = "(codex cli default)";

/** Default display model for Pi CLI when PI_MODEL is unset. */
export const DEFAULT_PI_MODEL = "(pi default)";

/** Default display model for Antigravity CLI when ANTIGRAVITY_MODEL is unset. */
export const DEFAULT_ANTIGRAVITY_MODEL = "(antigravity default)";

/**
 * Role -> model id registry. Edit these to re-target the whole app.
 */
export const MODEL_REGISTRY: Record<ModelRole, string> = {
  subagent: DEFAULT_SUBAGENT_MODEL, // deep domain sub-agents + consolidation
  synthesis: DEFAULT_STRONG_MODEL, // main final analysis (deep synthesis + live agent)
  ranking: DEFAULT_STRONG_MODEL, // reserved (currently unused)
};

/** The single default model id (used by resolveModel's fallback + status display). */
export const DEFAULT_MODEL = DEFAULT_SUBAGENT_MODEL;

/**
 * Resolve a model id for a given role. Provider-aware:
 *   - claude-code: CLAUDE_CODE_MODEL env (or DEFAULT_CLAUDE_CODE_MODEL). Role
 *     tiers are ignored — one model per claude-code session.
 *   - codex-cli: CODEX_CLI_MODEL env (or Codex CLI's own configured default).
 *     Role tiers are ignored — one model per codex session.
 *   - pi: PI_MODEL env (or DEFAULT_PI_MODEL). Role tiers are ignored.
 *   - antigravity: ANTIGRAVITY_MODEL / AGY_MODEL env (or DEFAULT_ANTIGRAVITY_MODEL).
 *     Role tiers are ignored.
 *   - openai: OPENAI_MODEL env (overrides every role) → MODEL_REGISTRY[role].
 */
export function resolveModel(role: ModelRole = "subagent"): string {
  const provider = resolveProvider();
  if (provider === "claude-code") {
    return process.env.CLAUDE_CODE_MODEL?.trim() || DEFAULT_CLAUDE_CODE_MODEL;
  }
  if (provider === "codex-cli") {
    return process.env.CODEX_CLI_MODEL?.trim() || DEFAULT_CODEX_CLI_MODEL;
  }
  if (provider === "pi") {
    return process.env.PI_MODEL?.trim() || DEFAULT_PI_MODEL;
  }
  if (provider === "antigravity") {
    return (
      process.env.ANTIGRAVITY_MODEL?.trim() ||
      process.env.AGY_MODEL?.trim() ||
      DEFAULT_ANTIGRAVITY_MODEL
    );
  }
  const env = process.env.OPENAI_MODEL;
  if (env && env.trim()) return env.trim();
  const registered = (MODEL_REGISTRY as Record<string, string | undefined>)[
    role
  ];
  return registered ?? DEFAULT_MODEL;
}

/** Human-readable summary of the active provider + role split, for logs / TUI. */
export function describeModels(): string {
  const provider = resolveProvider();
  if (provider === "claude-code") {
    const m = resolveModel();
    const bin = process.env.CLAUDE_CODE_BIN?.trim() || "claude";
    return `provider: claude-code (${bin}) · model: ${m}`;
  }
  if (provider === "codex-cli") {
    const m = resolveModel();
    const bin = process.env.CODEX_CLI_BIN?.trim() || "codex";
    const sandbox = process.env.CODEX_CLI_SANDBOX?.trim() || "read-only";
    return `provider: codex-cli (${bin}) · model: ${m} · sandbox: ${sandbox}`;
  }
  if (provider === "pi") {
    const m = resolveModel();
    const bin = process.env.PI_BIN?.trim() || "pi";
    const prov = process.env.PI_PROVIDER?.trim();
    return `provider: pi (${bin}) · model: ${m}${prov ? ` · backend: ${prov}` : ""}`;
  }
  if (provider === "antigravity") {
    const m = resolveModel();
    const bin =
      process.env.ANTIGRAVITY_BIN?.trim() ||
      process.env.AGY_BIN?.trim() ||
      "agy";
    const effort =
      process.env.ANTIGRAVITY_EFFORT?.trim() ||
      process.env.AGY_EFFORT?.trim();
    return `provider: antigravity (${bin}) · model: ${m}${effort ? ` · effort: ${effort}` : ""}`;
  }
  const overridden = !!(
    process.env.OPENAI_MODEL && process.env.OPENAI_MODEL.trim()
  );
  if (overridden)
    return `provider: openai · model: ${resolveModel()} (all roles, via OPENAI_MODEL)`;
  const sub = resolveModel("subagent");
  const syn = resolveModel("synthesis");
  const rank = resolveModel("ranking");
  const deduped = [...new Set([sub, syn, rank])];
  if (deduped.length === 1) return `provider: openai · model: ${sub} (all roles)`;
  return `provider: openai · models: subagent ${sub} · synthesis ${syn} · ranking ${rank}`;
}
