import { afterEach, describe, expect, test } from "bun:test";
import { describeModels, resolveModel } from "../../config/models.ts";
import { resolveProvider } from "./index.ts";

const ENV_KEYS = [
  "LLM_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "CLAUDE_CODE_MODEL",
  "CODEX_CLI_BIN",
  "CODEX_CLI_MODEL",
  "CODEX_CLI_SANDBOX",
  "PI_BIN",
  "PI_MODEL",
  "PI_PROVIDER",
  "PI_THINKING",
  "ANTIGRAVITY_BIN",
  "ANTIGRAVITY_MODEL",
  "ANTIGRAVITY_EFFORT",
  "AGY_BIN",
  "AGY_MODEL",
  "AGY_EFFORT",
] as const;

const ORIGINAL_ENV: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
for (const key of ENV_KEYS) {
  const value = process.env[key];
  if (value !== undefined) ORIGINAL_ENV[key] = value;
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
});

describe("provider resolution", () => {
  test("normalizes provider aliases through explicit provider resolution", () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";

    expect(resolveProvider({ provider: " CODEX " })).toBe("codex-cli");
    expect(resolveProvider({ provider: "codexcli" })).toBe("codex-cli");
    expect(resolveProvider({ provider: "claude" })).toBe("claude-code");
    expect(resolveProvider({ provider: "claudecode" })).toBe("claude-code");
    expect(resolveProvider({ provider: "pi" })).toBe("pi");
    expect(resolveProvider({ provider: " PI " })).toBe("pi");
    expect(resolveProvider({ provider: "antigravity" })).toBe("antigravity");
    expect(resolveProvider({ provider: "antigrav" })).toBe("antigravity");
    expect(resolveProvider({ provider: "agy" })).toBe("antigravity");
  });

  test("keeps CLI providers opt-in even when OpenAI credentials are present", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = "https://example.invalid/v1";

    process.env.LLM_PROVIDER = "codex-cli";
    expect(resolveProvider()).toBe("codex-cli");

    process.env.LLM_PROVIDER = "pi";
    expect(resolveProvider()).toBe("pi");

    process.env.LLM_PROVIDER = "antigravity";
    expect(resolveProvider()).toBe("antigravity");
  });

  test("reports unsupported provider names with the accepted provider set", () => {
    expect(() => resolveProvider({ provider: "local-codex" })).toThrow(
      'Unknown LLM provider "local-codex". Use "openai", "claude-code", "codex-cli", "pi", or "antigravity".',
    );
  });
});

describe("codex-cli model resolution", () => {
  test("uses CODEX_CLI_MODEL for every role and describes the selected CLI settings", () => {
    process.env.LLM_PROVIDER = "codex";
    process.env.OPENAI_MODEL = "api-model-that-must-not-win";
    process.env.CODEX_CLI_BIN = "/opt/osint-ai/codex";
    process.env.CODEX_CLI_MODEL = "gpt-5.5-codex";
    process.env.CODEX_CLI_SANDBOX = "workspace-write";

    expect(resolveModel("subagent")).toBe("gpt-5.5-codex");
    expect(resolveModel("synthesis")).toBe("gpt-5.5-codex");
    expect(resolveModel("ranking")).toBe("gpt-5.5-codex");
    expect(describeModels()).toBe(
      "provider: codex-cli (/opt/osint-ai/codex) · model: gpt-5.5-codex · sandbox: workspace-write",
    );
  });
});

describe("pi model resolution", () => {
  test("uses PI_MODEL for every role and describes pi CLI settings", () => {
    process.env.LLM_PROVIDER = "pi";
    process.env.OPENAI_MODEL = "api-model-that-must-not-win";
    process.env.PI_BIN = "/opt/pi/bin/pi";
    process.env.PI_MODEL = "google/gemini-3.6-flash";
    process.env.PI_PROVIDER = "google";

    expect(resolveModel("subagent")).toBe("google/gemini-3.6-flash");
    expect(resolveModel("synthesis")).toBe("google/gemini-3.6-flash");
    expect(resolveModel("ranking")).toBe("google/gemini-3.6-flash");
    expect(describeModels()).toBe(
      "provider: pi (/opt/pi/bin/pi) · model: google/gemini-3.6-flash · backend: google",
    );
  });
});

describe("antigravity model resolution", () => {
  test("uses ANTIGRAVITY_MODEL for every role and describes antigravity CLI settings", () => {
    process.env.LLM_PROVIDER = "antigravity";
    process.env.OPENAI_MODEL = "api-model-that-must-not-win";
    process.env.ANTIGRAVITY_BIN = "/usr/local/bin/agy";
    process.env.ANTIGRAVITY_MODEL = "Gemini 3.7 Pro";
    process.env.ANTIGRAVITY_EFFORT = "high";

    expect(resolveModel("subagent")).toBe("Gemini 3.7 Pro");
    expect(resolveModel("synthesis")).toBe("Gemini 3.7 Pro");
    expect(resolveModel("ranking")).toBe("Gemini 3.7 Pro");
    expect(describeModels()).toBe(
      "provider: antigravity (/usr/local/bin/agy) · model: Gemini 3.7 Pro · effort: high",
    );
  });
});
