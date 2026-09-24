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
  };
}

/** The subject's real corpus, for evidence validation. When provided, every
 *  structured-finding quote must appear in `texts` and every permalink must
 *  belong to `permalinks`; otherwise the evidence entry is dropped (it carries
 *  zero weight). Built from the RAW pre-filter Reddit history so identifiers /
 *  quotes in filtered-out items are still recognized. */
export interface CorpusManifest {
  /** raw item texts (body + title), pre-filter */
  texts: string[];
  /** normalized permalinks that legitimately belong to this subject's corpus */
  permalinks: Set<string>;
}

/** Normalize a permalink for corpus membership comparison: strip scheme +
 *  host + query + trailing slash, lowercase. Tolerates the LLM emitting a
 *  full https URL for what the corpus stores as a bare path. */
function normalizePermalinkForValidation(p: string): string {
  let s = p.trim();
  try {
    const u = new URL(s);
    s = u.pathname + u.search;
  } catch {
    s = s.replace(/^https?:\/\/[^/]+/i, "");
  }
  return s.replace(/\/+$/, "").toLowerCase();
}

/** Normalize a quote for substring comparison: collapse whitespace, lowercase. */
function normalizeForQuote(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** True when `candidate` permalink corresponds to a real corpus permalink,
 *  tolerating post-vs-comment depth differences via bidirectional prefixing. */
function permalinkInCorpus(candidate: string, validPerms: Set<string>): boolean {
  const c = normalizePermalinkForValidation(candidate);
  if (!c) return false;
  if (validPerms.has(c)) return true;
  for (const v of validPerms) {
    if (v.startsWith(c) || c.startsWith(v)) return true;
  }
  return false;
}

/** Build a CorpusManifest from raw Reddit posts + comments (pre-filter). */
export function buildCorpusManifest(
  items: Array<{ body?: string; title?: string; permalink?: string }>,
): CorpusManifest {
  const texts: string[] = [];
  const permalinks = new Set<string>();
  for (const it of items) {
    texts.push(`${it.body ?? ""} ${it.title ?? ""}`);
    if (it.permalink) permalinks.add(normalizePermalinkForValidation(it.permalink));
  }
  return { texts, permalinks };
}

/**
 * Validate structured-findings evidence against the real corpus.
 *
 * Schema-valid evidence is not necessarily real evidence: a model can emit a
 * plausible-looking quote + permalink that exists nowhere in the source. This
 * drops evidence entries whose permalink is not a corpus permalink or whose
 * quote does not appear in the corpus text, so unsupported evidence carries
 * zero weight downstream (corroboration counts only surviving permalinks).
 *
 * When no `manifest` is supplied (standard live path — no raw corpus in hand),
 * only URL-shape validation runs: malformed permalinks are dropped but quotes
 * cannot be checked, so the run degrades gracefully instead of over-filtering.
 */
export function validateStructuredFindings(
  sf: StructuredFindings,
  manifest?: CorpusManifest,
): StructuredFindings {
  const dropped: string[] = [];
  let checked = 0;
  let unsupported = 0;

  const hasCorpus = !!manifest && manifest.permalinks.size > 0;
  const joined = hasCorpus ? normalizeForQuote(manifest!.texts.join("\n\n")) : "";
  const validPerms = hasCorpus
    ? new Set([...manifest!.permalinks].map(normalizePermalinkForValidation))
    : new Set<string>();

  const findings = sf.findings.map((f) => {
    const evidence = f.evidence.filter((e) => {
      checked++;
      const p = (e.permalink ?? "").trim();
      const q = (e.quote ?? "").trim();
      // Always reject non-URL / non-path permalinks (shape check, every path).
      if (p && !/^https?:\/\//i.test(p) && !p.startsWith("/r/")) {
        unsupported++;
        dropped.push(`malformed permalink: ${p.slice(0, 80)}`);
        return false;
      }
      if (!hasCorpus) return true; // cannot check membership without a corpus
      // Permalink must belong to this subject's corpus.
      if (p && !permalinkInCorpus(p, validPerms)) {
        unsupported++;
        dropped.push(`permalink not in corpus: ${p.slice(0, 80)}`);
        return false;
      }
      // Quote must actually appear in the corpus text (skip very short quotes
      // — too noisy to assert on).
      if (q && q.length >= 8 && !joined.includes(normalizeForQuote(q))) {
        unsupported++;
        dropped.push(`quote not in corpus: ${q.slice(0, 60)}`);
        return false;
      }
      return true;
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
