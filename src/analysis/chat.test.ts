/**
 * Unit tests for the report-grounded chat module (src/analysis/chat.ts).
 *
 * Covers the pure helpers only — slash-command rendering and system-prompt
 * construction — so the tests stay hermetic (no provider round-trips).
 */

import { describe, expect, test } from "bun:test";
import { buildChatSystemPrompt, runSlashCommand, type ChatContext } from "./chat.ts";

const ctx: ChatContext = {
  username: "alice",
  report: "# Report for alice\n\nThe subject is based in Seattle.",
  structured: {
    overallRisk: "high",
    summary: "Resolves to a Seattle-based developer.",
    identity: {
      exactUser: "Alice Example",
      rationale: "GitHub + Reddit cross-match.",
      publicProofUrls: ["https://github.com/alice-example"],
    },
    findings: [
      {
        category: "location",
        claim: "Subject lives in Seattle.",
        confidence: "high",
        rationale: "Multiple posts mention Seattle landmarks.",
        evidence: [{ quote: "I commute over the I-90 bridge", permalink: "https://reddit.com/x" }],
        remediation: "Remove neighborhood references.",
      },
    ],
  },
  directIdentifiers: {
    emails: ["alice@example.com"],
    socialHandles: [{ platform: "github", handle: "alice-example", url: "https://github.com/alice-example" }],
  },
};

describe("chat slash commands", () => {
  test("/help lists the command set", () => {
    const out = runSlashCommand("/help", ctx) ?? "";
    expect(out).toContain("/summary");
    expect(out).toContain("/findings");
    expect(out).toContain("/identifiers");
    expect(out).toContain("/exit");
  });

  test("/summary returns the structured summary", () => {
    const out = runSlashCommand("/summary", ctx);
    expect(out).toContain("Seattle-based developer");
  });

  test("/findings lists categories and confidence", () => {
    const out = runSlashCommand("/findings", ctx) ?? "";
    expect(out).toContain("[location]");
    expect(out).toContain("(high)");
  });

  test("/identifiers lists emails and handles", () => {
    const out = runSlashCommand("/identifiers", ctx) ?? "";
    expect(out).toContain("alice@example.com");
    expect(out).toContain("github:alice-example");
  });

  test("unknown slash commands return null", () => {
    expect(runSlashCommand("/bogus", ctx)).toBeNull();
  });
});

describe("buildChatSystemPrompt", () => {
  test("grounds the persona in the report and structured artifacts", () => {
    const prompt = buildChatSystemPrompt(ctx);
    expect(prompt).toContain("u/alice");
    expect(prompt).toContain("Seattle");
    expect(prompt).toContain("overallRisk: high");
    expect(prompt).toContain("alice@example.com");
    expect(prompt).toContain("github:alice-example");
  });

  test("handles a bare context without optional artifacts", () => {
    const prompt = buildChatSystemPrompt({ username: "bob", report: "nothing here" });
    expect(prompt).toContain("u/bob");
    expect(prompt).not.toContain("overallRisk");
  });
});
