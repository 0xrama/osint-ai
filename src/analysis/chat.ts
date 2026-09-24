/**
 * Report-grounded interactive chat ("chat with the verdict").
 *
 * After a scan completes, the operator can open a conversational REPL that
 * answers questions ABOUT the audit report — why a conclusion was drawn, what
 * evidence supports a finding, how to remediate, etc. The assistant is grounded
 * strictly in the report artifacts (narrative content, structured findings,
 * corroboration verdict, direct identifiers), not in the raw Reddit corpus.
 *
 * Provider-agnostic: multi-turn turns go through getLLMClient().complete() so
 * the same chat works on any backend (openai, claude-code, codex-cli, pi,
 * antigravity). The chat is intentionally tool-free — it reasons over the
 * already-collected evidence rather than re-hunting the web.
 *
 * Entry points:
 *   - startChatRepl(context)  — interactive CLI REPL (after a scan, or with
 *                               --chat <username> to chat about a saved report)
 *   - answerChatTurn(context, history, question) — programmatic one-shot turn
 *                               (used by the web dashboard /api/chat endpoint)
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getLLMClient } from "../runtime/providers/index.ts";
import { resolveModel } from "../config/models.ts";
import type { StructuredFindings } from "./findings.ts";
import type { DirectIdentifiers } from "./extract.ts";
import type { CorroborationResult } from "./corroboration.ts";

/** The report artifacts the chat is grounded in. */
export interface ChatContext {
  username: string;
  /** Full markdown report body. */
  report: string;
  /** Machine-readable findings projection (optional). */
  structured?: StructuredFindings;
  /** Regex-extracted concrete leaks (optional). */
  directIdentifiers?: DirectIdentifiers;
  /** Deterministic corroboration verdict (optional). */
  corroboration?: CorroborationResult;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Slash commands handled natively in the REPL (no LLM round-trip). */
const SLASH_COMMANDS = new Set(["/help", "/summary", "/findings", "/identifiers", "/report", "/exit"]);

/** Render the structured findings as a compact block for the system prompt. */
function renderStructuredBlock(structured?: StructuredFindings): string {
  if (!structured) return "";
  const lines: string[] = ["## STRUCTURED FINDINGS (machine-readable projection)", ""];
  lines.push(`overallRisk: ${structured.overallRisk}`);
  lines.push(`summary: ${structured.summary}`);
  if (structured.identity) {
    lines.push(`identity.exactUser: ${structured.identity.exactUser}`);
    lines.push(`identity.rationale: ${structured.identity.rationale}`);
    if (structured.identity.publicProofUrls.length > 0) {
      lines.push(`identity.publicProofUrls: ${structured.identity.publicProofUrls.join(", ")}`);
    }
  }
  for (const finding of structured.findings) {
    lines.push("");
    lines.push(`- [${finding.category}] (${finding.confidence}) ${finding.claim}`);
    if (finding.rationale) lines.push(`  rationale: ${finding.rationale}`);
    for (const ev of finding.evidence.slice(0, 2)) {
      if (ev.quote) lines.push(`  evidence: "${ev.quote.slice(0, 220)}"`);
    }
    if (finding.remediation) lines.push(`  remediation: ${finding.remediation}`);
  }
  return lines.join("\n");
}

/** Render the corroboration verdict for the system prompt. */
function renderCorroborationBlock(corroboration?: CorroborationResult): string {
  if (!corroboration) return "";
  const lines: string[] = ["## CORROBORATION (deterministic cross-signal fusion)", ""];
  lines.push(`overallRisk: ${corroboration.overallRisk} · score: ${corroboration.score}`);
  for (const cluster of corroboration.clusters) {
    lines.push(`- [${cluster.signalType}] "${cluster.value}" (${cluster.confidence}, ${cluster.independentSources} sources, ${cluster.domainCount} domains): ${cluster.evidence.join(" | ").slice(0, 220)}`);
  }
  if (corroboration.contradictions.length > 0) {
    lines.push("");
    lines.push("contradictions:");
    for (const c of corroboration.contradictions) lines.push(`- ${JSON.stringify(c).slice(0, 200)}`);
  }
  return lines.join("\n");
}

/** Build the investigator persona system prompt, grounded in the report. */
export function buildChatSystemPrompt(ctx: ChatContext): string {
  const block = [
    "You are an expert OSINT investigator assistant for osint-ai.",
    "",
    `You are discussing the completed audit of Reddit user u/${ctx.username}.`,
    "Answer the operator's questions STRICTLY from the provided report artifacts below.",
    "Rules:",
    "  - Never invent evidence, URLs, or claims that are not in the report.",
    "  - If the report does not contain an answer, say so plainly and suggest what additional data would help.",
    "  - Ground every answer: cite the finding, quote, or section you are relying on.",
    "  - Be concrete about remediation when asked (what to scrub, what to verify).",
    "  - Do not perform new web research — this chat reasons over the completed audit only.",
    "",
    "========== AUDIT REPORT FOR u/" + ctx.username + " ==========",
    ctx.report.slice(0, 24_000),
  ].join("\n");

  const structured = renderStructuredBlock(ctx.structured);
  const corroboration = renderCorroborationBlock(ctx.corroboration);
  const identifiers = ctx.directIdentifiers
    ? [
        "## DIRECT IDENTIFIERS (regex-extracted)",
        `emails: ${ctx.directIdentifiers.emails.join(", ") || "none"}`,
        `socialHandles: ${ctx.directIdentifiers.socialHandles.map((h) => `${h.platform}:${h.handle}`).join(", ") || "none"}`,
      ].join("\n")
    : "";

  const extras = [structured, corroboration, identifiers].filter(Boolean).join("\n\n");
  return extras ? `${block}\n\n${extras}` : block;
}

/** One chat turn: ask a question against the report context. */
export async function answerChatTurn(
  ctx: ChatContext,
  history: ChatMessage[],
  question: string,
): Promise<string> {
  const client = getLLMClient();
  const transcript = history
    .map((m) => `${m.role === "user" ? "OPERATOR" : "ASSISTANT"}: ${m.content}`)
    .join("\n\n");
  const userPrompt = transcript
    ? `Conversation so far:\n\n${transcript}\n\n---\n\nOPERATOR: ${question}`
    : `OPERATOR: ${question}`;
  return client.complete({
    system: buildChatSystemPrompt(ctx),
    user: userPrompt,
    model: resolveModel("synthesis"),
    temperature: 0.3,
  });
}

/** Handle a built-in slash command; returns a printable response or null if unhandled. */
export function runSlashCommand(cmd: string, ctx: ChatContext): string | null {
  switch (cmd) {
    case "/help":
      return [
        "Commands:",
        "  /help         show this help",
        "  /summary      print the report summary / person brief",
        "  /findings     list structured findings (categories + confidence)",
        "  /identifiers  list direct identifiers (emails + handles)",
        "  /report       print the full report",
        "  /exit         leave the chat",
        "",
        "Otherwise, ask a question about the audit — e.g.",
        "  \"Why did you conclude the location is Seattle?\"",
        "  \"Which findings are HIGH confidence and why?\"",
        "  \"What should I scrub first?\"",
      ].join("\n");
    case "/summary": {
      const brief = ctx.structured?.summary;
      return brief ? `summary: ${brief}` : "No structured summary available. Try /report.";
    }
    case "/findings": {
      if (!ctx.structured || ctx.structured.findings.length === 0) {
        return "No structured findings available.";
      }
      return ctx.structured.findings
        .map((f) => `- [${f.category}] (${f.confidence}) ${f.claim}`)
        .join("\n");
    }
    case "/identifiers": {
      if (!ctx.directIdentifiers) return "No direct identifiers captured.";
      const emails = ctx.directIdentifiers.emails;
      const handles = ctx.directIdentifiers.socialHandles.map((h) => `${h.platform}:${h.handle}`);
      return [
        emails.length ? `emails: ${emails.join(", ")}` : "emails: none",
        handles.length ? `socialHandles: ${handles.join(", ")}` : "socialHandles: none",
      ].join("\n");
    }
    case "/report":
      return ctx.report.slice(0, 60_000) || "(empty report)";
    default:
      return null;
  }
}

/**
 * Interactive REPL over a completed audit. Exits on /exit, EOF (Ctrl+D), or
 * an empty line. Returns when the user leaves.
 */
export async function startChatRepl(ctx: ChatContext): Promise<void> {
  const rl = createInterface({ input, output });
  const history: ChatMessage[] = [];

  console.log("");
  console.log(`Chatting about u/${ctx.username} (type /help for commands, /exit to leave)`);
  console.log("");

  try {
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line) continue;
      if (line === "/exit") break;

      if (line.startsWith("/") && SLASH_COMMANDS.has(line)) {
        const reply = runSlashCommand(line, ctx);
        if (reply) console.log(`\n${reply}\n`);
        continue;
      }

      history.push({ role: "user", content: line });
      try {
        const answer = await answerChatTurn(ctx, history, line);
        history.push({ role: "assistant", content: answer });
        console.log(`\n${answer.trim()}\n`);
      } catch (err: any) {
        console.error(`\n(chat error: ${err?.message ?? err})\n`);
        history.pop();
      }
    }
  } finally {
    rl.close();
  }
}
