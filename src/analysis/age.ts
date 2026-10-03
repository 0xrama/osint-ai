/**
 * Deterministic degree-timeline age estimator.
 *
 * Age is the #1 recurring accuracy bug in this project (AGENTS.md gotcha #4):
 * LLMs assume a non-traditional ~21 enrollment age for a standard bachelor's
 * and inflate estimates by 2–3 years. The synthesis prompt's AGE INFERENCE
 * CALIBRATION section forces the milestone → enrollment → birth-year chain,
 * but it relies on the model obeying. This module is the bulletproof fix:
 * the same philosophy as `extract.ts` / `timezone.ts` — pure regex + code
 * over the finished report's own claims, no LLM. Education-system norms
 * (bachelor starts ~18, master ~21, PhD ~24) live in a tunable constant
 * table, the arithmetic is deterministic, and the rendered
 * "## Deterministic Age Estimate" block is injected as ground truth the
 * narrative cannot contradict without new evidence.
 *
 * Design notes:
 * - A milestone only counts when an explicit 4-digit year (1990–2035 sanity
 *   window) appears within ±120 chars of it — a "2nd year" claim with no
 *   date anchors nothing.
 * - The yearKind comes from the governing verb ("graduated"/"class of" vs
 *   "started"/"enrolled" vs bare co-occurrence = stated-during).
 * - Age ranges account for birthday timing: someone born in year B is
 *   (nowYear − B − 1) or (nowYear − B) at any given date, so a single birth
 *   year yields a 2-year age range. This is deliberate, not slack.
 * - Bracket phrases alone ("in my twenties") carry no year, so they get a
 *   wide low-confidence estimate and are never merged with degree-timeline
 *   estimates.
 * - Pure module: no fetch, no LLM, no Date.now (now is injected), no fs.
 */

/** Programs we have education-system norms for. */
export type EducationProgram = "bachelor" | "master" | "phd";

/**
 * Nominal education norms, one row per program. Tunable: if a region's
 * system shifts (or eval fixtures demand it), edit the table — the parsing
 * and arithmetic never change.
 */
export interface EducationNorm {
  /** Nominal age at enrollment for a traditional student (the calibration). */
  startAge: number;
  /** Shortest realistic program duration in years (range widening only). */
  durationMin: number;
  /** Longest realistic program duration in years (range widening only). */
  durationMax: number;
  /** The duration used for arithmetic (graduation-year back-computation). */
  durationNominal: number;
}

/** The norms table (AGENTS.md gotcha #4 / ROADMAP #13). */
export const EDUCATION_NORMS: Record<EducationProgram, EducationNorm> = {
  bachelor: { startAge: 18, durationMin: 3, durationMax: 4, durationNominal: 4 },
  master: { startAge: 21, durationMin: 2, durationMax: 2, durationNominal: 2 },
  phd: { startAge: 24, durationMin: 4, durationMax: 6, durationNominal: 5 },
};

/**
 * A dated education milestone parsed from report text. `ordinal` (the
 * year-in-program number, 1-based) is carried as an optional extra so
 * `estimateAges` can compute enrollment = year − (ordinal − 1) for
 * stated-during milestones without re-parsing the milestone label.
 */
export interface EducationMilestone {
  milestone: string;
  program: EducationProgram;
  year: number;
  yearKind: "stated-during" | "enrolled" | "graduated" | "class-of";
  /** Verbatim window around the match, for provenance. */
  snippet: string;
  /** Year-in-program (1-based) when the milestone states one ("2nd year", "semester 3" → 2). */
  ordinal?: number;
}

/** Result of one age estimate. Pure data, no methods. */
export interface AgeEstimate {
  birthYearRange: [number, number];
  /** Ages relative to the injected `now`, birthday-timing aware (spans 2 years per birth year). */
  ageRange: [number, number];
  /** The explicit arithmetic, e.g. "2nd-year bachelor stated 2024 → enrolled ~2023 → born ~2023−18=2005 → age 20–21 at 2026-10-03". */
  chain: string;
  /** Verbatim snippet the milestone was parsed from. */
  basis: string;
  /** "bracket" marks the low-confidence age-bracket fallback (no year, no program). */
  program: EducationProgram | "bracket";
  confidence: "medium" | "low";
}

// ── Degree keyword patterns ────────────────────────────────────────────
// Tolerant of B.Sc / BSc / B Sc / BSc. spellings. Lookahead (not \b) at
// the tail so trailing dots ("B.Sc.") don't break the boundary check.

const DEGREE_TOKENS: Record<EducationProgram, string> = {
  bachelor: [
    "b\\s*\\.?\\s*sc(?![a-z0-9])\\.?",
    "b\\s*\\.?\\s*a(?![a-z0-9])\\.?",
    "b\\s*\\.?\\s*com(?![a-z0-9])\\.?",
    "b\\s*\\.?\\s*b\\s*\\.?\\s*a(?![a-z0-9])\\.?",
    "b\\s*\\.?\\s*tech(?![a-z0-9])\\.?",
    "b\\s*\\.?\\s*e(?![a-z0-9])\\.?",
    "bachelor(?:'?s)?(?![a-z0-9])",
    "undergrad(?:uate)?(?![a-z0-9])",
    "college(?![a-z0-9])",
  ].join("|"),
  master: [
    "m\\s*\\.?\\s*sc(?![a-z0-9])\\.?",
    "m\\s*\\.?\\s*ba(?![a-z0-9])\\.?",
    "m\\s*\\.?\\s*tech(?![a-z0-9])\\.?",
    "master(?:'?s)?(?![a-z0-9])",
    "postgrad(?:uate)?(?![a-z0-9])",
  ].join("|"),
  phd: ["p\\s*\\.?\\s*h\\s*\\.?\\s*d(?![a-z0-9])\\.?", "doctorate(?![a-z0-9])"].join("|"),
};

const PROGRAMS: EducationProgram[] = ["bachelor", "master", "phd"];

/** Sanity window for a plausible education-related year. */
const YEAR_MIN = 1990;
const YEAR_MAX = 2035;
/** A milestone only counts when a year appears this close to it. */
const YEAR_RADIUS = 120;

const ORDINAL_WORDS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };

interface YearHit {
  year: number;
  index: number;
}

function findYears(text: string): YearHit[] {
  const out: YearHit[] = [];
  const re = /\b(19[89]\d|20[0-3]\d)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const y = parseInt(m[1], 10);
    if (y >= YEAR_MIN && y <= YEAR_MAX) out.push({ year: y, index: m.index });
  }
  return out;
}

function nearestYear(years: YearHit[], index: number, radius = YEAR_RADIUS): YearHit | null {
  let best: YearHit | null = null;
  let bestDist = radius + 1;
  for (const y of years) {
    const d = Math.abs(y.index - index);
    if (d <= radius && d < bestDist) {
      best = y;
      bestDist = d;
    }
  }
  return best;
}

function nearestProgram(text: string, index: number, radius = YEAR_RADIUS): EducationProgram | null {
  let best: EducationProgram | null = null;
  let bestDist = radius + 1;
  for (const program of PROGRAMS) {
    const re = new RegExp(DEGREE_TOKENS[program], "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const d = Math.abs(m.index - index);
      if (d <= radius && d < bestDist) {
        best = program;
        bestDist = d;
      }
    }
  }
  return best;
}

/**
 * Classify what a nearby year MEANS by its governing verb: "graduated /
 * class of" → graduation year, "started / joined / enrolled" → enrollment
 * year, bare co-occurrence → the milestone was stated during that year.
 */
function classifyYear(text: string, yearIndex: number): EducationMilestone["yearKind"] {
  const window = text.slice(Math.max(0, yearIndex - 60), yearIndex + 20).toLowerCase();
  if (/\bgraduat/.test(window) || /passing\s+out/.test(window)) return "graduated";
  if (/class\s+of/.test(window)) return "class-of";
  if (/\b(started|joined|enrol)/.test(window)) return "enrolled";
  return "stated-during";
}

function windowSnippet(text: string, index: number): string {
  return text
    .slice(Math.max(0, index - 80), Math.min(text.length, index + 80))
    .replace(/\s+/g, " ")
    .trim();
}

function ordinalSuffix(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return "st";
  if (n % 10 === 2 && n % 100 !== 12) return "nd";
  if (n % 10 === 3 && n % 100 !== 13) return "rd";
  return "th";
}

/**
 * Parse dated education milestones out of report text.
 *
 * Why regex: the claim lives in the report's own prose ("I'm in my 2nd year
 * of my BSc", "graduated B.Tech in 2021", "class of 2019"), and the LLM
 * narrative already quotes it — we only need to catch it deterministically.
 * A milestone counts only when a degree keyword AND an explicit year (within
 * ±120 chars, 1990–2035) are both found; "class of YYYY" without any degree
 * keyword defaults to bachelor (the overwhelmingly common case).
 *
 * Deterministic: output is sorted by year, then milestone string.
 */
export function parseEducationTimelines(text: string): EducationMilestone[] {
  const out: EducationMilestone[] = [];
  const years = findYears(text);

  // 1. "2nd year" / "second year" / "final year"
  const NTH_RE =
    /\b(\d{1,2})(?:st|nd|rd|th)\s+year\b|\b(first|second|third|fourth|fifth)\s+year\b|\b(final|last)\s+year\b/gi;
  let m: RegExpExecArray | null;
  while ((m = NTH_RE.exec(text)) !== null) {
    const idx = m.index;
    const program = nearestProgram(text, idx);
    if (!program) continue;
    let ordinal: number | undefined;
    if (m[1] !== undefined) ordinal = parseInt(m[1], 10);
    else if (m[2] !== undefined) ordinal = ORDINAL_WORDS[m[2].toLowerCase()];
    else ordinal = EDUCATION_NORMS[program].durationMax; // "final year" = nominal last year
    if (ordinal < 1 || ordinal > 10) continue;
    const y = nearestYear(years, idx);
    if (!y) continue;
    out.push({
      milestone: `${ordinal}${ordinalSuffix(ordinal)} year ${program}`,
      program,
      year: y.year,
      yearKind: classifyYear(text, y.index),
      snippet: windowSnippet(text, idx),
      ordinal,
    });
  }

  // 2. "semester 3" → year-in-program = ceil(semesters / 2)
  const SEM_RE = /\bsemester\s+(\d{1,2})\b/gi;
  while ((m = SEM_RE.exec(text)) !== null) {
    const idx = m.index;
    const program = nearestProgram(text, idx);
    if (!program) continue;
    const semester = parseInt(m[1], 10);
    if (semester < 1 || semester > 12) continue;
    const ordinal = Math.ceil(semester / 2);
    const y = nearestYear(years, idx);
    if (!y) continue;
    out.push({
      milestone: `semester ${semester} ${program}`,
      program,
      year: y.year,
      yearKind: classifyYear(text, y.index),
      snippet: windowSnippet(text, idx),
      ordinal,
    });
  }

  // 3. "doing / pursuing / studying my <degree>" (program comes from the degree token)
  for (const program of PROGRAMS) {
    const re = new RegExp(
      `\\b(?:doing|pursuing|studying)\\s+(?:my|a|an|the)?\\s*(?:${DEGREE_TOKENS[program]})`,
      "gi",
    );
    while ((m = re.exec(text)) !== null) {
      const idx = m.index;
      const y = nearestYear(years, idx);
      if (!y) continue;
      out.push({
        milestone: `in ${program}`,
        program,
        year: y.year,
        yearKind: classifyYear(text, y.index),
        snippet: windowSnippet(text, idx),
      });
    }
  }

  // 4. "graduated (in) YYYY" / "will graduate YYYY" — degree keyword nearby
  const GRAD_RE = /\b(?:graduated|graduating|will\s+graduate|graduation)\b[^;\n]{0,60}?(19[89]\d|20[0-3]\d)/gi;
  while ((m = GRAD_RE.exec(text)) !== null) {
    const y = parseInt(m[1], 10);
    if (y < YEAR_MIN || y > YEAR_MAX) continue;
    const program = nearestProgram(text, m.index);
    if (!program) continue;
    out.push({
      milestone: `graduated ${program}`,
      program,
      year: y,
      yearKind: "graduated",
      snippet: windowSnippet(text, m.index),
    });
  }

  // 5. "class of YYYY" — degree keyword nearby, else bachelor default
  const CLASS_RE = /\bclass\s+of\s+(19[89]\d|20[0-3]\d)\b/gi;
  while ((m = CLASS_RE.exec(text)) !== null) {
    const y = parseInt(m[1], 10);
    if (y < YEAR_MIN || y > YEAR_MAX) continue;
    const program = nearestProgram(text, m.index) ?? "bachelor";
    out.push({
      milestone: `class of ${y} ${program}`,
      program,
      year: y,
      yearKind: "class-of",
      snippet: windowSnippet(text, m.index),
    });
  }

  // Stable deterministic order: by year, then milestone label.
  out.sort((a, b) => a.year - b.year || (a.milestone < b.milestone ? -1 : a.milestone > b.milestone ? 1 : 0));
  return out;
}

function agesFromBirth(birth: [number, number], nowYear: number): [number, number] {
  // Birthday-timing aware: born in year B, at any point during nowYear the
  // person is nowYear−B−1 (birthday not yet passed) or nowYear−B.
  return [nowYear - birth[1] - 1, nowYear - birth[0]];
}

function milestoneToEstimate(ms: EducationMilestone, nowYear: number, dateISO: string): AgeEstimate {
  const norm = EDUCATION_NORMS[ms.program];
  let birth: [number, number];
  let chain: string;

  if (ms.yearKind === "stated-during" && ms.ordinal !== undefined) {
    // "2nd year" stated during year Y → enrolled Y − (N − 1).
    const enrolled = ms.year - (ms.ordinal - 1);
    const b = enrolled - norm.startAge;
    birth = [b, b];
    chain = `${ms.milestone} stated ${ms.year} → enrolled ~${enrolled} → born ~${enrolled}−${norm.startAge}=${b}`;
  } else if (ms.yearKind === "stated-during") {
    // In the program during year Y, year-in-program not stated: enrollment
    // is anywhere in [Y − durationMax + 1, Y].
    const earliest = ms.year - norm.durationMax + 1;
    birth = [earliest - norm.startAge, ms.year - norm.startAge];
    chain = `in ${ms.program} during ${ms.year} (year not stated) → enrolled ${earliest}–${ms.year} → born ~${birth[0]}–${birth[1]} (start age ${norm.startAge})`;
  } else if (ms.yearKind === "enrolled") {
    const b = ms.year - norm.startAge;
    birth = [b, b];
    chain = `started ${ms.program} in ${ms.year} → born ~${ms.year}−${norm.startAge}=${b}`;
  } else {
    // graduated / class-of: enrollment = graduation − nominal duration;
    // widen ±1 to absorb 3-vs-4-year programs and start-age spread.
    const enrolled = ms.year - norm.durationNominal;
    const center = enrolled - norm.startAge;
    birth = [center - 1, center + 1];
    const label = ms.yearKind === "class-of" ? `class of ${ms.year}` : `graduated ${ms.year}`;
    chain = `${label} (${ms.program}, ~${norm.durationNominal}-year program) → enrolled ~${enrolled} → born ~${enrolled}−${norm.startAge}=${center} ±1`;
  }

  const age = agesFromBirth(birth, nowYear);
  chain = `${chain} → age ${age[0]}–${age[1]} at ${dateISO}`;
  return { birthYearRange: birth, ageRange: age, chain, basis: ms.snippet, program: ms.program, confidence: "medium" };
}

// ── Bracket fallback ───────────────────────────────────────────────────
// "in my twenties", "early 20s" — no year anywhere near, so wide + low.

const DECADE_BASE: Record<string, number> = { twenties: 20, thirties: 30, forties: 40, "20s": 20, "30s": 30, "40s": 40 };

function bracketRange(qualifier: string | undefined, base: number): [number, number] {
  if (!qualifier) return [base, base + 9];
  const q = qualifier.toLowerCase();
  if (q.startsWith("earl")) return [base, base + 2];
  if (q.startsWith("mid")) return [base + 3, base + 6];
  return [base + 7, base + 9]; // late
}

function parseBrackets(text: string, nowYear: number, dateISO: string): AgeEstimate[] {
  const years = findYears(text);
  const out: AgeEstimate[] = [];
  const seen = new Set<string>();
  const DEC_RE = /\b(?:in (?:my|his|her|their) )?(early |mid(?:dle)? |late )?(twenties|thirties|forties)\b/gi;
  const DIG_RE = /\b(early |mid(?:dle)? |late )(20s|30s|40s)\b/gi;
  for (const re of [DEC_RE, DIG_RE]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Only a fallback: if an explicit year sits nearby, the degree-timeline
      // path already owns this stretch of text.
      if (nearestYear(years, m.index) !== null) continue;
      const qualifier = m[1]?.trim();
      const base = DECADE_BASE[(m[2] ?? m[3]).toLowerCase()];
      if (base === undefined) continue;
      const [lo, hi] = bracketRange(qualifier, base);
      const key = `${lo}-${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const birth: [number, number] = [nowYear - hi - 1, nowYear - lo];
      out.push({
        birthYearRange: birth,
        ageRange: [lo, hi],
        chain: `stated age bracket "${m[0].trim()}" (no year anywhere near it) → age ${lo}–${hi} at ${dateISO} → born ~${birth[0]}–${birth[1]}`,
        basis: windowSnippet(text, m.index),
        program: "bracket",
        confidence: "low",
      });
    }
  }
  return out;
}

// ── Estimate assembly ──────────────────────────────────────────────────

function mergeCluster(members: AgeEstimate[]): AgeEstimate {
  if (members.length === 1) return members[0];
  // Overlapping birth ranges agree: keep the tightest (intersection) and
  // every chain string so the reader sees each contributing milestone.
  const birth: [number, number] = [
    Math.max(...members.map((e) => e.birthYearRange[0])),
    Math.min(...members.map((e) => e.birthYearRange[1])),
  ];
  const nowYear = members[0].ageRange[0] + members[0].birthYearRange[1] + 1; // reconstruct from birthday math
  const age = agesFromBirth(birth, nowYear);
  const narrowest = [...members].sort(
    (a, b) =>
      a.birthYearRange[1] - a.birthYearRange[0] - (b.birthYearRange[1] - b.birthYearRange[0]) ||
      a.birthYearRange[0] - b.birthYearRange[0],
  )[0];
  return {
    birthYearRange: birth,
    ageRange: age,
    chain: members.map((e) => e.chain).join(" | "),
    basis: members.map((e) => e.basis).join(" ; "),
    program: narrowest.program,
    confidence: "medium",
  };
}

/**
 * Compute deterministic age estimates from report texts.
 *
 * Why: this is the post-pass that retires the prompt-only AGE INFERENCE
 * CALIBRATION (gotcha #4) — the norms are applied as code over the report's
 * own claims, so the arithmetic cannot drift no matter what the model
 * narrated. Education estimates with overlapping birth-year ranges are
 * merged into the tightest intersection (keeping every chain); disagreeing
 * estimates are all kept so the renderer can flag the conflict. Bracket
 * hints never merge with degree-timeline estimates.
 */
export function estimateAges(texts: string[], now: Date): AgeEstimate[] {
  const joined = texts.join("\n");
  const nowYear = now.getUTCFullYear();
  const dateISO = now.toISOString().slice(0, 10);

  const milestones = parseEducationTimelines(joined);
  const seen = new Set<string>();
  const edu: AgeEstimate[] = [];
  for (const ms of milestones) {
    const key = `${ms.program}|${ms.year}|${ms.yearKind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edu.push(milestoneToEstimate(ms, nowYear, dateISO));
  }

  // Cluster by overlap (sorted by range start; compare against the running
  // max end so transitive overlaps cluster together).
  const sorted = [...edu].sort(
    (a, b) => a.birthYearRange[0] - b.birthYearRange[0] || a.birthYearRange[1] - b.birthYearRange[1],
  );
  const clusters: AgeEstimate[][] = [];
  let clusterEnd = -Infinity;
  for (const est of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && est.birthYearRange[0] <= clusterEnd) {
      last.push(est);
      clusterEnd = Math.max(clusterEnd, est.birthYearRange[1]);
    } else {
      clusters.push([est]);
      clusterEnd = est.birthYearRange[1];
    }
  }
  const merged = clusters.map(mergeCluster);

  const brackets = parseBrackets(joined, nowYear, dateISO);
  return [...merged, ...brackets].sort(
    (a, b) =>
      a.birthYearRange[0] - b.birthYearRange[0] ||
      a.birthYearRange[1] - b.birthYearRange[1] ||
      (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0),
  );
}

/**
 * Render the "## Deterministic Age Estimate" report block, in the style of
 * `renderTimezoneBlock`: each estimate's chain spelled out, the tightest /
 * agreed range highlighted, disagreement flagged loudly, and the framing
 * line that tells the reader this is arithmetic, not narrative. Empty input
 * renders "" so callers can append unconditionally.
 */
export function renderAgeBlock(estimates: AgeEstimate[], now: Date): string {
  if (estimates.length === 0) return "";
  const nowYear = now.getUTCFullYear();
  const dateISO = now.toISOString().slice(0, 10);
  const width = (r: [number, number]) => r[1] - r[0];
  const edu = estimates.filter((e) => e.program !== "bracket");
  const brackets = estimates.filter((e) => e.program === "bracket");
  const tightest = [...estimates].sort(
    (a, b) => width(a.birthYearRange) - width(b.birthYearRange) || a.birthYearRange[0] - b.birthYearRange[0],
  )[0];

  const lines: string[] = [];
  lines.push(`## Deterministic Age Estimate`);
  lines.push(
    `*Deterministic degree-timeline arithmetic over the report's own claims — the narrative cannot contradict this without new evidence.*`,
  );
  lines.push("");
  for (const est of estimates) {
    const tag = est === tightest ? " ◄ tightest range" : "";
    lines.push(
      `- **${est.program}** (confidence: ${est.confidence}${tag}): **age ~${est.ageRange[0]}–${est.ageRange[1]} at ${dateISO}** (born ~${est.birthYearRange[0]}–${est.birthYearRange[1]})`,
    );
    lines.push(`  - Chain: ${est.chain}`);
    lines.push(`  - Basis: "${est.basis}"`);
  }
  if (edu.length > 1) {
    const ranges = edu.map((e) => `${e.birthYearRange[0]}–${e.birthYearRange[1]}`).join(" vs ");
    lines.push("");
    lines.push(
      `- **⚠ CONFLICT**: the degree-timeline estimates above DISAGREE (born ~${ranges}). They were NOT merged — the narrative must resolve this with new evidence, not average it away.`,
    );
  } else if (edu.length === 1) {
    const n = edu[0].chain.includes(" | ") ? edu[0].chain.split(" | ").length : 1;
    lines.push("");
    lines.push(
      `- **Consensus**: ${n === 1 ? "single milestone" : `${n} agreeing milestones`} → age ~${edu[0].ageRange[0]}–${edu[0].ageRange[1]} at ${dateISO} (relative to ${nowYear}).`,
    );
  }
  if (brackets.length > 0) {
    lines.push("");
    lines.push(
      `- Bracket-only hints (no explicit year): wide and low-confidence — they can bound the age, never pin it.`,
    );
  }
  return lines.join("\n");
}
