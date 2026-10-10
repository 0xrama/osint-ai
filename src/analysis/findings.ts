/**
 * Structured findings extraction — a machine-readable layer on top of the
 * narrative synthesis report.
 *
 * Our pipeline produces rich markdown (multi-agent synthesis + web hunting),
 * which is great for humans but not diffable or machine-parseable. This module
 * runs ONE additional synthesis-tier call that reads the finished report (plus
 * the deterministic direct-identifier block) and re-projects it into a strict
 * JSON findings schema. Includes a JSON-repair fallback for flaky providers.
 *
 * Adapted from the "deanonymizer" reference project's chunk schema + repair.
 */

import { promptOnce } from "../runtime/llm.ts";
import type { DirectIdentifiers } from "./extract.ts";

export type FindingCategory =
  | "location"
  | "employer_or_school"
  | "real_name"
  | "age_or_dob"
  | "gender"
  | "relationships_or_family"
  | "financial"
  | "health"
  | "schedule_or_routine"
  | "cross_platform_handle"
  | "external_link"
  | "writing_fingerprint"
  | "other";

export interface Finding {
  category: FindingCategory;
  /** What an attacker concludes, in plain language. */
  claim: string;
  confidence: "low" | "medium" | "high";
  /** Why — the reasoning chain over the evidence. */
  rationale: string;
  /** Permalinks / quotes that leak it. */
  evidence: Array<{ quote: string; permalink: string }>;
  /** Concrete action: what the subject can scrub, or how to verify the lead. */
  remediation: string;
}

export type AccountStatus = "CONFIRMED" | "LIKELY" | "POSSIBLE" | "REJECTED";

/** The synthesis agent's same-person judgment for one account. A label only
 *  ever constrains corroboration (caps confidence, drops a rejected
 *  non-subject handle) — it never adds a source, so it needs no citation. */
export interface AccountVerification {
  platform: string;
  handle: string;
  url: string;
  status: AccountStatus;
  rationale: string;
}

export interface IdentityProof {
  /** The exact real-world identity the report resolves (or strongest candidate). */
  exactUser: string;
  /** Why the report believes this maps to the same user. */
  rationale: string;
  /** Public proof URLs: LinkedIn, GitHub, personal site, profile pages. */
  publicProofUrls: string[];
}

export interface StructuredFindings {
  overallRisk: "low" | "medium" | "high";
  summary: string;
  identity?: IdentityProof;
  findings: Finding[];
  accounts?: AccountVerification[];
  /** Result of validating evidence against the real corpus (set by
   *  validateStructuredFindings). Schema-valid ≠ real evidence: this records
   *  which quotes/permalinks were actually supported by the source. */
  evidenceValidation?: {
    checked: number;
    supported: number;
    unsupported: number;
    dropped: string[];
  };
}

export const SCHEMA_HINT = `Return a JSON object of exactly this shape:
{
  "overallRisk": "low" | "medium" | "high",
  "summary": "2-4 sentence plain-language exposure/attribution summary",
  "identity": {
    "exactUser": "single string naming the resolved real identity (or the strongest ranked candidate), else the audited handle",
    "rationale": "short explanation of why this is the same user",
    "publicProofUrls": ["https://..."]
  },
  "accounts": [
    {
      "platform": "github | x | ...",
      "handle": "account handle",
      "url": "https://platform/account",
      "status": "CONFIRMED" | "LIKELY" | "POSSIBLE" | "REJECTED",
      "rationale": "why this is (or is not) the same person"
    }
  ],
  "findings": [
    {
      "category": "location" | "employer_or_school" | "real_name" | "age_or_dob" | "gender" | "relationships_or_family" | "financial" | "health" | "schedule_or_routine" | "cross_platform_handle" | "external_link" | "writing_fingerprint" | "other",
      "claim": "what an attacker concludes",
      "confidence": "low" | "medium" | "high",
      "rationale": "the reasoning chain over the evidence",
      "evidence": [ { "quote": "verbatim snippet", "permalink": "https://..." } ],
      "remediation": "concrete action to reduce or verify this exposure"
    }
  ]
}`;

const SYSTEM_PROMPT = `You are a de-anonymization analyst converting a narrative identity-resolution report into a strict, machine-readable findings structure.

Read the report below (plus the deterministic direct-identifier block) and extract EVERY identity-relevant finding it establishes into the JSON schema.

RULES
- Only extract findings the report actually supports with evidence — do NOT invent new claims, names, or URLs.
- Every quote MUST be copied verbatim from the source Reddit history, and every permalink MUST be a real Reddit URL that appears in the audited corpus. Paraphrased quotes and invented/foreign permalinks are discarded by validation and carry zero weight.
- For each finding: category, the claim an attacker concludes, calibrated confidence (high/medium/low), the reasoning chain, the leaking quote + permalink from the report, and a concrete remediation or verification step.
- overallRisk: "high" when many strong identifiers (real name, employer, email, confirmed cross-platform accounts) converge on one person; "medium" when several weak signals triangulate; "low" when little is resolvable.
- identity.exactUser: the resolved real-world identity the report points to (or the strongest ranked candidate if multiple). If the report cannot resolve a real identity, set exactUser to the audited Reddit handle and explain the gap in rationale.
- Preserve every public proof URL the report cites (GitHub, LinkedIn, personal site, profile pages).
- accounts: carry the report's verification label for every account it assessed. Username equality or profile existence alone is POSSIBLE; REJECTED needs cited mismatch evidence.
- Output ONLY the JSON object. No prose, no code fences.`;

function safeJsonSlice(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return raw;
  }
  return raw.slice(start, end + 1);
}

function emptyFindings(): StructuredFindings {
  return {
    overallRisk: "low",
    summary: "Structured extraction failed; no findings emitted.",
    findings: [],
  };
}

function coerceFinding(raw: any): Finding {
  return {
    category: (raw?.category ?? "other") as FindingCategory,
    claim: String(raw?.claim ?? "").trim(),
    confidence: (["low", "medium", "high"].includes(raw?.confidence)
      ? raw.confidence
      : "low") as Finding["confidence"],
    rationale: String(raw?.rationale ?? "").trim(),
    evidence: Array.isArray(raw?.evidence)
      ? raw.evidence
          .map((e: any) => ({
            quote: String(e?.quote ?? "").trim(),
            permalink: String(e?.permalink ?? "").trim(),
          }))
          .filter((e: { quote: string; permalink: string }) => e.quote || e.permalink)
      : [],
    remediation: String(raw?.remediation ?? "").trim(),
  };
}

function coerce(parsed: any): StructuredFindings {
  if (!parsed || typeof parsed !== "object") return emptyFindings();
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map(coerceFinding).filter((f: Finding) => f.claim || f.rationale)
    : [];
  const riskRaw = parsed.overallRisk;
  const overallRisk = (["low", "medium", "high"].includes(riskRaw)
    ? riskRaw
    : "low") as StructuredFindings["overallRisk"];
  const identity = parsed.identity
    ? {
        exactUser: String(parsed.identity.exactUser ?? "").trim(),
        rationale: String(parsed.identity.rationale ?? "").trim(),
        publicProofUrls: Array.isArray(parsed.identity.publicProofUrls)
          ? parsed.identity.publicProofUrls
              .map((u: any) => String(u ?? "").trim())
              .filter((u: string) => /^https?:\/\//i.test(u))
          : [],
      }
    : undefined;
  return {
    overallRisk,
    summary: String(parsed.summary ?? "").trim(),
    identity,
    findings,
    accounts: Array.isArray(parsed.accounts)
      ? parsed.accounts
          .filter((a: any) => ["CONFIRMED", "LIKELY", "POSSIBLE", "REJECTED"].includes(a?.status) && a?.handle)
          .map((a: any): AccountVerification => ({
            platform: String(a.platform ?? "").trim().toLowerCase(),
            handle: String(a.handle).trim(),
            url: String(a.url ?? "").trim(),
            status: a.status,
            rationale: String(a.rationale ?? "").trim(),
          }))
      : [],
  };
}

/** The subject's real corpus, for evidence validation. Built from the RAW
 *  pre-filter Reddit history so identifiers / quotes in filtered-out items are
 *  still recognized. A cited quote must appear in the text of the cited item —
 *  never just somewhere in the corpus — so a real quote cannot be paired with
 *  an unrelated real permalink. */
export interface CorpusManifest {
  /** every raw item text (title + body + external link-post URL), pre-filter —
   *  the input to deterministic identifier extraction */
  texts: string[];
  /** normalized item permalink → that item's text */
  items: Map<string, string>;
}

/** Normalize a permalink for corpus membership comparison: strip scheme +
 *  host + query + trailing slash, lowercase. Tolerates the LLM emitting a
 *  full https URL for what the corpus stores as a bare path. */
function normalizePermalinkForValidation(p: string): string {
  let s = p.trim();
  try {
    s = new URL(s).pathname;
  } catch {
    s = s.replace(/^https?:\/\/[^/]+/i, "").replace(/[?#].*$/, "");
  }
  return s.replace(/\/+$/, "").toLowerCase();
}

/** Normalize a quote for substring comparison: collapse whitespace, lowercase. */
function normalizeForQuote(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** An item permalink names a thread (`/comments/<id>`); a bare `/r/sub` would
 *  prefix-match every item in that subreddit. */
const ITEM_PERMALINK_RE = /\/comments\/[a-z0-9]+/;

/** Corpus items a cited permalink can refer to: the exact item, or one at a
 *  different thread depth (a comment permalink is the post permalink + comment
 *  id, and models drop/add the slug). Matching is on whole path segments. */
function citedItems(candidate: string, items: Map<string, string>): Array<[string, string]> {
  const c = normalizePermalinkForValidation(candidate);
  if (!ITEM_PERMALINK_RE.test(c)) return [];
  return [...items]
    .filter(([k]) => k === c || k.startsWith(`${c}/`) || c.startsWith(`${k}/`))
    .sort(([a], [b]) => Number(b === c) - Number(a === c)); // exact item first
}

/** The external URL of a link post (the poster's GitHub, blog, video…), or ""
 *  for self posts, comments and Reddit-hosted media / crossposts. */
export function externalLinkUrl(item: { url?: string }): string {
  const url = String(item.url ?? "").trim();
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(^|\.)(reddit\.com|redd\.it|redditmedia\.com)$/.test(host) ? "" : url;
  } catch {
    return "";
  }
}

/** Build a CorpusManifest from raw Reddit posts + comments (pre-filter). */
export function buildCorpusManifest(
  items: Array<{ body?: string; title?: string; selftext?: string; url?: string; permalink?: string }>,
): CorpusManifest {
  const texts: string[] = [];
  const byPermalink = new Map<string, string>();
  for (const it of items) {
    // Posts carry their body in `selftext`, comments in `body`.
    const text = `${it.title ?? ""} ${it.selftext ?? ""} ${it.body ?? ""} ${externalLinkUrl(it)}`;
    texts.push(text);
    if (it.permalink) byPermalink.set(normalizePermalinkForValidation(it.permalink), text);
  }
  return { texts, items: byPermalink };
}

/**
 * Validate structured-findings evidence against the real corpus.
 *
 * Schema-valid evidence is not necessarily real evidence: a model can emit a
 * plausible-looking quote + permalink that exists nowhere in the source, or
 * pair a real quote with an unrelated real permalink. An entry survives only
 * when its permalink names a corpus item (`/comments/<id>`, depth-tolerant) and
 * its quote — any length — appears in THAT item's text. A surviving permalink
 * is rewritten to the matched item's canonical permalink, so corroboration can
 * count it once and look up the cited item's text.
 *
 * When no `manifest` is supplied, only URL-shape validation runs: malformed
 * permalinks are dropped but quotes cannot be checked. An EMPTY manifest means
 * "the run holds no Reddit text": every permalinked/quoted entry is unverifiable
 * and dropped (zero weight), while the finding's claim is kept.
 */
export function validateStructuredFindings(
  sf: StructuredFindings,
  manifest?: CorpusManifest,
): StructuredFindings {
  const dropped: string[] = [];
  let checked = 0;
  let unsupported = 0;

  const hasCorpus = !!manifest && (manifest.items.size > 0 || manifest.texts.length > 0);
  const reject = (reason: string): never[] => {
    unsupported++;
    dropped.push(reason);
    return [];
  };

  const findings = sf.findings.map((f) => {
    const evidence = f.evidence.flatMap((e) => {
      checked++;
      const p = (e.permalink ?? "").trim();
      const q = normalizeForQuote(e.quote ?? "");
      // Always reject non-URL / non-path permalinks (shape check, every path).
      if (p && !/^https?:\/\//i.test(p) && !p.startsWith("/r/")) {
        return reject(`malformed permalink: ${p.slice(0, 80)}`);
      }
      if (!manifest) return [e]; // cannot check membership without a corpus
      if (!hasCorpus) {
        return p || q ? reject(`no corpus text to verify: ${(p || q).slice(0, 80)}`) : [e];
      }
      if (!p) {
        // A bare quote carries no source weight; it only has to be real.
        return !q || manifest.texts.some((t) => normalizeForQuote(t).includes(q))
          ? [e]
          : reject(`quote not in corpus: ${q.slice(0, 60)}`);
      }
      const candidates = citedItems(p, manifest.items);
      if (candidates.length === 0) return reject(`permalink not in corpus: ${p.slice(0, 80)}`);
      const hit = candidates.find(([, text]) => !q || normalizeForQuote(text).includes(q));
      if (!hit) return reject(`quote not in cited item: ${q.slice(0, 60)}`);
      return [{ ...e, permalink: `https://reddit.com${hit[0]}` }];
    });
    return { ...f, evidence };
  });

  return {
    ...sf,
    findings,
    evidenceValidation: {
      checked,
      supported: checked - unsupported,
      unsupported,
      dropped: dropped.slice(0, 25),
    },
  };
}

/**
 * Parse model output into structured findings, repairing malformed JSON with
 * up to 2 LLM repair attempts before degrading to an empty result. Mirrors the
 * reference project's repair path so flaky providers never abort the run.
 */
async function parseWithRepair(
  text: string,
  onProgress?: (msg: string) => void,
): Promise<StructuredFindings> {
  try {
    return coerce(JSON.parse(safeJsonSlice(text)));
  } catch {
    // fall through to repair
  }

  const repairPrompt = `The text below should contain a JSON object but is malformed.
Repair it into valid JSON matching this schema exactly, preserving meaning.
Return ONLY valid JSON.

${SCHEMA_HINT}

Malformed text:
${text.slice(0, 60000)}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      onProgress?.(`[findings] Repairing structured output (attempt ${attempt + 1}/2)...`);
      const repaired = await promptOnce(
        "You repair malformed JSON into valid JSON matching the given schema. Output ONLY the JSON object.",
        repairPrompt,
        { role: "synthesis", temperature: 0.1 },
      );
      return coerce(JSON.parse(safeJsonSlice(repaired)));
    } catch {
      // completion errored or still invalid — retry once more, then degrade.
    }
  }

  return emptyFindings();
}

/**
 * Run the structured-extraction pass over a finished report.
 *
 * @param reportText  The narrative synthesis / live-agent markdown report.
 * @param di          Deterministic direct identifiers (folded into the prompt).
 * @param username    The audited Reddit handle (fallback identity label).
 */
export async function extractStructuredFindings(
  reportText: string,
  di: DirectIdentifiers | undefined,
  username: string,
  onProgress?: (msg: string) => void,
): Promise<StructuredFindings> {
  const directBlock = di
    ? `\n\nDETERMINISTIC DIRECT IDENTIFIERS (regex-extracted; treat as ground truth):\n${
        di.emails.length ? `Emails: ${di.emails.join(", ")}` : "(no emails)"
      }\n${
        di.socialHandles.length
          ? di.socialHandles.map((h) => `${h.platform}:${h.handle} (${h.url})`).join("\n")
          : "(no cross-platform handles)"
      }`
    : "";

  const userPrompt = `Audited Reddit handle: u/${username}

=== IDENTITY-RESOLUTION REPORT ===
${reportText.slice(0, 60000)}
=== END REPORT ===${directBlock}

${SCHEMA_HINT}`;

  onProgress?.("[findings] Extracting structured findings from report...");
  const text = await promptOnce(SYSTEM_PROMPT, userPrompt, {
    role: "synthesis",
    temperature: 0.3,
  });

  return parseWithRepair(text, onProgress);
}

const CONF_BADGE: Record<Finding["confidence"], string> = {
  high: "🔴 HIGH",
  medium: "🟡 MEDIUM",
  low: "⚪ LOW",
};

const RISK_BADGE: Record<StructuredFindings["overallRisk"], string> = {
  high: "🔴 HIGH",
  medium: "🟡 MEDIUM",
  low: "🟢 LOW",
};

const CONF_ORDER: Record<Finding["confidence"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** Render structured findings as a markdown appendix. */
export function renderStructuredFindings(sf: StructuredFindings): string {
  const lines: string[] = [];
  lines.push(`## Structured Findings (Machine-Readable)`);
  lines.push("");
  lines.push(`**Overall risk:** ${RISK_BADGE[sf.overallRisk]}`);
  if (sf.summary) {
    lines.push("");
    lines.push(`> ${sf.summary}`);
  }

  if (sf.identity) {
    lines.push("");
    lines.push(`### Identity`);
    lines.push(`- **Resolved user:** ${sf.identity.exactUser || "unresolved"}`);
    if (sf.identity.rationale) lines.push(`- **Rationale:** ${sf.identity.rationale}`);
    if (sf.identity.publicProofUrls.length) {
      lines.push(`- **Public proof URLs:**`);
      for (const u of sf.identity.publicProofUrls) lines.push(`  - ${u}`);
    }
  }

  if (sf.evidenceValidation && sf.evidenceValidation.checked > 0) {
    const v = sf.evidenceValidation;
    lines.push("");
    lines.push(
      `*Evidence validation:* ${v.supported}/${v.checked} evidence entries supported by the source corpus${v.unsupported > 0 ? `; ${v.unsupported} dropped as unsupported (zero weight)` : ""}.*`,
    );
  }

  if (sf.accounts?.length) {
    // Its own section ahead of the block the dashboard parses as cards.
    const accountLines = ["## Account Verification", ""];
    for (const a of sf.accounts) {
      accountLines.push(`- **${a.status}** [${a.platform}:${a.handle}](${a.url})${a.rationale ? ` — ${a.rationale}` : ""}`);
    }
    lines.unshift(...accountLines, "", "---", "");
  }

  if (sf.findings.length === 0) {
    lines.push("");
    lines.push(`*No structured findings extracted.*`);
    return lines.join("\n");
  }

  const sorted = [...sf.findings].sort(
    (a, b) => CONF_ORDER[a.confidence] - CONF_ORDER[b.confidence],
  );

  let current: Finding["confidence"] | null = null;
  for (const f of sorted) {
    if (f.confidence !== current) {
      lines.push("");
      lines.push(`### ${f.confidence[0].toUpperCase()}${f.confidence.slice(1)} confidence`);
      current = f.confidence;
    }
    lines.push("");
    lines.push(`**[${f.category}]** ${f.claim}  ${CONF_BADGE[f.confidence]}`);
    if (f.rationale) lines.push(`- *Why:* ${f.rationale}`);
    for (const e of f.evidence) {
      if (e.quote) lines.push(`  - \`${e.quote.replace(/\s+/g, " ").slice(0, 240)}\``);
      if (e.permalink) lines.push(`    ${e.permalink}`);
    }
    if (f.remediation) lines.push(`- *Fix/verify:* ${f.remediation}`);
  }

  return lines.join("\n");
}
