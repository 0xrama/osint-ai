/**
 * Deterministic posting-time timezone estimator.
 *
 * Timezone was previously inferred only by an LLM sub-agent "look at posting
 * times" prompt — non-deterministic and easy to get wrong. This module is the
 * same philosophy as `extract.ts` / `web-sweep.ts`: pure regex/math over the
 * corpus, no LLM. Reddit items carry `created_utc` unix seconds; a person's
 * sleep window (local 01:00–07:00) is the most reliable clock signature in
 * posting times, so we find the UTC offset that pushes the FEWEST posts into
 * that window. The result is injected into the synthesis prompt as ground
 * truth and rendered as a report block the model cannot contradict.
 *
 * Design notes:
 * - Candidate grid is every 30-minute step from UTC−12:00 to UTC+14:00
 *   inclusive (covers all real offsets including India's +05:30 and
 *   Nepal's +05:45 rounded to the grid).
 * - Hour-class granularity (floor to the local wall-clock hour) means offsets
 *   30 minutes apart can only be distinguished when timestamps carry minute
 *   components — real Reddit data does, so this is fine in practice.
 * - Ties prefer the daytime-maximizing offset, then the smaller |offset|
 *   (an ambiguous distribution should collapse to UTC+00:00, not a coin flip).
 */

/** Result of the sleep-window-fit timezone estimate. Pure data, no methods. */
export interface TimezoneEstimate {
  /** Best-fit UTC offset in minutes, positive EAST of UTC (e.g. 330 = UTC+05:30). */
  offsetMinutes: number;
  /** Human-readable label, e.g. "UTC+05:30", "UTC-05:00", "UTC+00:00". */
  label: string;
  /** Number of finite positive timestamps the estimate is based on. */
  postCount: number;
  /** Confidence tier; "low" includes near-uniform hour distributions. */
  confidence: "low" | "medium" | "high";
  /** Share of posts whose local wall-clock hour falls in [01:00, 07:00) at the winning offset. */
  nightFraction: number;
  /** Second-best offset by the same ordering, when a meaningful runner-up exists. */
  runnerUpOffsetMinutes?: number;
  /** Night-window share at the runner-up offset (the comparison that drives confidence). */
  runnerUpNightFraction?: number;
  /** 24 bins: count of posts per local wall-clock hour at the WINNING offset. */
  localHourHistogram: number[];
}

/**
 * Format an offset in minutes as a "UTC±HH:MM" label. Zero is "UTC+00:00" by
 * convention (the tie-break prefers 0, so it must render stably).
 */
export function formatOffsetLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

/** Candidate offsets: 30-minute steps across UTC−12:00 … UTC+14:00 inclusive. */
const CANDIDATE_OFFSETS: number[] = (() => {
  const out: number[] = [];
  for (let m = -12 * 60; m <= 14 * 60; m += 30) out.push(m);
  return out;
})();

interface CandidateScore {
  offsetMinutes: number;
  nightFraction: number;
  dayFraction: number;
}

/** Local wall-clock hour (0–23) of a unix timestamp at a given offset. */
function localHour(utcSeconds: number, offsetMinutes: number): number {
  const shifted = utcSeconds + offsetMinutes * 60;
  const modDay = ((shifted % 86400) + 86400) % 86400;
  return Math.floor(modDay / 3600);
}

/**
 * Estimate the subject's UTC offset by sleep-window minimization.
 *
 * Why this works: almost nobody posts regularly during local 01:00–07:00, so
 * the offset that empties that window best approximates the subject's
 * residence timezone. Deterministic and pure — same input, same output.
 *
 * Returns null when fewer than 10 finite positive timestamps survive input
 * filtering (too little evidence to say anything).
 */
export function estimateUtcOffset(timestamps: number[]): TimezoneEstimate | null {
  // Guard NaN / non-finite / non-positive inputs; they carry no signal.
  const clean = timestamps.filter((t) => Number.isFinite(t) && t > 0);
  if (clean.length < 10) return null;

  const scored: CandidateScore[] = CANDIDATE_OFFSETS.map((offsetMinutes) => {
    let night = 0;
    let day = 0;
    for (const ts of clean) {
      const h = localHour(ts, offsetMinutes);
      if (h >= 1 && h < 7) night++;
      else if (h >= 8 && h < 22) day++;
    }
    return {
      offsetMinutes,
      nightFraction: night / clean.length,
      dayFraction: day / clean.length,
    };
  });

  // Order: fewest night posts, then most daytime posts, then smallest
  // |offset| (prefer UTC+00:00 when truly ambiguous), then offset ascending
  // so the sort is a total deterministic order.
  scored.sort((a, b) => {
    if (a.nightFraction !== b.nightFraction) return a.nightFraction - b.nightFraction;
    if (a.dayFraction !== b.dayFraction) return b.dayFraction - a.dayFraction;
    const aa = Math.abs(a.offsetMinutes);
    const ab = Math.abs(b.offsetMinutes);
    if (aa !== ab) return aa - ab;
    return a.offsetMinutes - b.offsetMinutes;
  });

  const best = scored[0];
  const runnerUp = scored[1]; // grid always has ≥2 candidates

  // Near-uniform hour distributions carry no clock signal: if the timestamps
  // occupy fewer than 4 distinct UTC hours, no offset can be preferred.
  const distinctUtcHours = new Set(clean.map((t) => Math.floor((t % 86400) / 3600))).size;

  let confidence: TimezoneEstimate["confidence"] = "low";
  if (distinctUtcHours >= 4) {
    if (clean.length >= 40 && best.nightFraction <= 0.5 * runnerUp.nightFraction) {
      confidence = "high";
    } else if (clean.length >= 20 && best.nightFraction < runnerUp.nightFraction) {
      confidence = "medium";
    }
  }

  const histogram = new Array<number>(24).fill(0);
  for (const ts of clean) histogram[localHour(ts, best.offsetMinutes)]++;

  return {
    offsetMinutes: best.offsetMinutes,
    label: formatOffsetLabel(best.offsetMinutes),
    postCount: clean.length,
    confidence,
    nightFraction: best.nightFraction,
    runnerUpOffsetMinutes: runnerUp.offsetMinutes,
    runnerUpNightFraction: runnerUp.nightFraction,
    localHourHistogram: histogram,
  };
}

/**
 * Render the estimate as a "## Posting-Time Timezone Estimate" report block,
 * in the style of `renderWebSweepBlock`: the verdict, its evidence (night
 * fraction vs runner-up), the full local-hour histogram, and an honest
 * caveat. The histogram lets a human reader second-guess the fit.
 */
export function renderTimezoneBlock(est: TimezoneEstimate): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const runner =
    est.runnerUpOffsetMinutes !== undefined && est.runnerUpNightFraction !== undefined
      ? ` vs ${pct(est.runnerUpNightFraction)} at the runner-up offset ${formatOffsetLabel(est.runnerUpOffsetMinutes)}`
      : "";

  const hours = est.localHourHistogram.map((_, h) => String(h).padStart(2, "0")).join("|");
  const counts = est.localHourHistogram.map((c) => String(c).padStart(2, "0")).join("|");

  const lines: string[] = [];
  lines.push(`## Posting-Time Timezone Estimate`);
  lines.push(
    `*Deterministic sleep-window fit over the posting times (no LLM): the UTC offset whose local 01:00–07:00 window contains the smallest share of activity is the best-fit residence timezone. Same philosophy as the web sweep — regex/math the LLM cannot contradict.*`,
  );
  lines.push("");
  lines.push(`- **Estimate**: **${est.label}** (confidence: ${est.confidence}; positive = east of UTC)`);
  lines.push(`- **Basis**: ${est.postCount} posts/comments; local-night share at best fit: ${pct(est.nightFraction)}${runner}`);
  lines.push(`- **Local hour histogram** (wall-clock hours at ${est.label}, 24 bins):`);
  lines.push("");
  lines.push("```");
  lines.push(`hour |${hours}|`);
  lines.push(`count|${counts}|`);
  lines.push("```");
  lines.push("");
  lines.push(
    `*Caveat: posting times only approximate awake hours; offsets are fit at 30-minute granularity (half-hour zones like UTC+05:30 are exact, quarter-hour zones are not). A matched offset narrows the region (a longitude band) but does not pin a country — many countries share each offset.*`,
  );
  return lines.join("\n");
}

/**
 * Render a short ground-truth injection line for the synthesis agent prompt
 * (the timezone analogue of `renderWebContextForPrompt`). The estimate was
 * computed deterministically from the full posting history, so the model is
 * told to corroborate or contradict location claims against it — never to
 * re-derive it by eyeballing times.
 */
export function renderTimezoneContextForPrompt(est: TimezoneEstimate): string {
  const runner =
    est.runnerUpNightFraction !== undefined
      ? `; night-window fit ${(est.nightFraction * 100).toFixed(1)}% at best offset vs ${(est.runnerUpNightFraction * 100).toFixed(1)}% at runner-up`
      : "";
  return `POSTING-TIME TIMEZONE ESTIMATE (deterministic from ${est.postCount} posts/comments): ${est.label} (confidence: ${est.confidence}${runner}). Use this to corroborate or contradict location claims — it is a longitude band, not a country.`;
}
