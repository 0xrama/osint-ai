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
 * - Many offsets often tie at the minimum night share (an empty window fits
 *   anywhere inside the subject's quiet gap). The estimate is the MIDPOINT of
 *   the widest contiguous plateau of minimum-night offsets, and the plateau
 *   bounds are reported. Picking the daytime-maximizing tied offset instead
 *   skewed night owls west (true +05:30 active 09–24h → +04:30 "high").
 *   The midpoint centres the quiet gap on local 04:00, so an unusual sleep
 *   schedule still shifts it — hence the reported range.
 * - Confidence comes from the contrast between the plateau's night share and
 *   the MEDIAN offset's, plus a narrow plateau — not from the runner-up, which
 *   is always a 30-minute neighbour with the same share.
 * - A plateau covering the whole grid carries no signal and collapses to
 *   UTC+00:00, not a coin flip.
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
  /** Westmost offset of the minimum-night plateau the estimate is the midpoint of. */
  plateauFromMinutes: number;
  /** Eastmost offset of that plateau (equal to `plateauFromMinutes` for a sharp fit). */
  plateauToMinutes: number;
  /** Night-window share at the median candidate offset (the contrast that drives confidence). */
  medianNightFraction: number;
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

  const night = CANDIDATE_OFFSETS.map((offsetMinutes) => {
    let n = 0;
    for (const ts of clean) {
      const h = localHour(ts, offsetMinutes);
      if (h >= 1 && h < 7) n++;
    }
    return n / clean.length;
  });
  const minNight = Math.min(...night);

  // Contiguous runs of minimum-night offsets (indices into the grid); keep
  // the widest, ties to the run whose midpoint is nearest UTC+00:00.
  type Run = { from: number; to: number; mid: number };
  const width = (r: Run) => r.to - r.from;
  let plateau: Run | null = null;
  for (let i = 0; i < night.length; i++) {
    if (night[i] !== minNight || (i > 0 && night[i - 1] === minNight)) continue;
    let j = i;
    while (j + 1 < night.length && night[j + 1] === minNight) j++;
    const run = { from: i, to: j, mid: Math.floor((i + j) / 2) };
    if (
      !plateau || width(run) > width(plateau) ||
      (width(run) === width(plateau) && Math.abs(CANDIDATE_OFFSETS[run.mid]) < Math.abs(CANDIDATE_OFFSETS[plateau.mid]))
    ) plateau = run;
  }
  const { from, to, mid } = plateau!; // minNight is attained, so a run exists
  const wholeGrid = from === 0 && to === night.length - 1;
  const offsetMinutes = wholeGrid ? 0 : CANDIDATE_OFFSETS[mid];
  const plateauWidth = CANDIDATE_OFFSETS[to] - CANDIDATE_OFFSETS[from];
  const sortedNight = [...night].sort((a, b) => a - b);
  const medianNight = sortedNight[Math.floor(sortedNight.length / 2)];

  // Near-uniform hour distributions carry no clock signal: if the timestamps
  // occupy fewer than 4 distinct UTC hours, no offset can be preferred.
  const distinctUtcHours = new Set(clean.map((t) => Math.floor((t % 86400) / 3600))).size;

  let confidence: TimezoneEstimate["confidence"] = "low";
  if (distinctUtcHours >= 4 && medianNight > 0) {
    if (clean.length >= 40 && medianNight >= 0.1 && minNight <= 0.25 * medianNight && plateauWidth <= 60) {
      confidence = "high";
    } else if (clean.length >= 20 && minNight <= 0.5 * medianNight && plateauWidth <= 240) {
      confidence = "medium";
    }
  }

  const histogram = new Array<number>(24).fill(0);
  for (const ts of clean) histogram[localHour(ts, offsetMinutes)]++;

  return {
    offsetMinutes,
    label: formatOffsetLabel(offsetMinutes),
    postCount: clean.length,
    confidence,
    nightFraction: minNight,
    plateauFromMinutes: CANDIDATE_OFFSETS[from],
    plateauToMinutes: CANDIDATE_OFFSETS[to],
    medianNightFraction: medianNight,
    localHourHistogram: histogram,
  };
}

/**
 * Render the estimate as a "## Posting-Time Timezone Estimate" report block,
 * in the style of `renderWebSweepBlock`: the verdict, its evidence (plateau
 * range, night fraction vs the median offset), the full local-hour histogram, and an honest
 * caveat. The histogram lets a human reader second-guess the fit.
 */
export function renderTimezoneBlock(est: TimezoneEstimate): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const range = est.plateauFromMinutes === est.plateauToMinutes
    ? ""
    : `; equally good fit across ${formatOffsetLabel(est.plateauFromMinutes)} … ${formatOffsetLabel(est.plateauToMinutes)} (midpoint reported)`;

  const hours = est.localHourHistogram.map((_, h) => String(h).padStart(2, "0")).join("|");
  const counts = est.localHourHistogram.map((c) => String(c).padStart(2, "0")).join("|");

  const lines: string[] = [];
  lines.push(`## Posting-Time Timezone Estimate`);
  lines.push(
    `*Deterministic sleep-window fit over the posting times (no LLM): the UTC offset whose local 01:00–07:00 window contains the smallest share of activity is the best-fit residence timezone. Same philosophy as the web sweep — regex/math the LLM cannot contradict.*`,
  );
  lines.push("");
  lines.push(`- **Estimate**: **${est.label}** (confidence: ${est.confidence}; positive = east of UTC${range})`);
  lines.push(`- **Basis**: ${est.postCount} posts/comments; local-night share at best fit: ${pct(est.nightFraction)} vs ${pct(est.medianNightFraction)} at the median offset`);
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
  const range = est.plateauFromMinutes === est.plateauToMinutes
    ? ""
    : `; plausible range ${formatOffsetLabel(est.plateauFromMinutes)} … ${formatOffsetLabel(est.plateauToMinutes)}`;
  const fit = `; night-window share ${(est.nightFraction * 100).toFixed(1)}% at best offset vs ${(est.medianNightFraction * 100).toFixed(1)}% at the median offset`;
  return `POSTING-TIME TIMEZONE ESTIMATE (deterministic from ${est.postCount} posts/comments): ${est.label} (confidence: ${est.confidence}${range}${fit}). Use this to corroborate or contradict location claims — it is a longitude band, not a country.`;
}

/* ────────────────────────────────────────────────────────────────────────
 * Place → plausible UTC-offset range
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Coarse country/region offset ranges (minutes east of UTC), used to falsify a
 * profile location against the posting-time fit. Deliberately country-level
 * and wide where a country spans zones (US, Russia, Australia): the point is to
 * catch a location on the other side of the world, not to geolocate. A place
 * absent from the table yields null and never contradicts.
 */
const PLACE_OFFSET_RANGES: Array<[RegExp, [number, number]]> = [
  [/\bindia\b|\bhyderabad\b|\bmumbai\b|\bdelhi\b|\bbengaluru\b|\bbangalore\b|\bchennai\b|\bkolkata\b|\bpune\b|\bgurgaon\b|\bnoida\b|\bahmedabad\b|\bjaipur\b|\blucknow\b/i, [330, 330]],
  [/\bpakistan\b|\bkarachi\b|\blahore\b|\bislamabad\b/i, [300, 300]],
  [/\bbangladesh\b|\bdhaka\b/i, [360, 360]],
  [/\bnepal\b|\bkathmandu\b/i, [345, 345]],
  [/\bsri lanka\b|\bcolombo\b/i, [330, 330]],
  [/\buk\b|\bunited kingdom\b|\blondon\b|\bmanchester\b|\bbirmingham\b|\bedinburgh\b|\bglasgow\b|\bdublin\b|\bireland\b|\bportugal\b|\blisbon\b/i, [0, 60]],
  [/\bgermany\b|\bfrance\b|\bnetherlands\b|\bspain\b|\bitaly\b|\bpoland\b|\bsweden\b|\bnorway\b|\bdenmark\b|\bswitzerland\b|\baustria\b|\bbelgium\b|\bczech\b|\bberlin\b|\bparis\b|\bamsterdam\b|\bmadrid\b|\bbarcelona\b|\brome\b|\bmilan\b|\bwarsaw\b|\bstockholm\b|\bmunich\b|\bvienna\b|\bzurich\b/i, [60, 120]],
  [/\bgreece\b|\bfinland\b|\bromania\b|\bbulgaria\b|\bturkey\b|\bisrael\b|\bukraine\b|\bkyiv\b|\bathens\b|\bhelsinki\b|\bbucharest\b|\bistanbul\b|\btel aviv\b/i, [120, 180]],
  [/\brussia\b|\bmoscow\b|\bsaint petersburg\b/i, [120, 720]],
  [/\buae\b|\bdubai\b|\babu dhabi\b|\bsaudi\b|\briyadh\b|\bqatar\b|\bdoha\b|\bkuwait\b|\bbahrain\b|\boman\b/i, [180, 240]],
  [/\biran\b|\btehran\b/i, [210, 210]],
  [/\bjapan\b|\btokyo\b|\bsouth korea\b|\bseoul\b/i, [540, 540]],
  [/\bchina\b|\bshanghai\b|\bbeijing\b|\bsingapore\b|\bhong kong\b|\btaiwan\b|\btaipei\b|\bphilippines\b|\bmanila\b|\bmalaysia\b|\bkuala lumpur\b/i, [480, 480]],
  [/\bindonesia\b|\bjakarta\b/i, [420, 540]],
  [/\bthailand\b|\bbangkok\b|\bvietnam\b|\bhanoi\b|\bho chi minh\b/i, [420, 420]],
  [/\baustralia\b|\bsydney\b|\bmelbourne\b|\bbrisbane\b|\bperth\b|\badelaide\b/i, [480, 660]],
  [/\bnew zealand\b|\bauckland\b|\bwellington\b/i, [720, 780]],
  [/\bbrazil\b|\bsao paulo\b|\brio de janeiro\b/i, [-300, -120]],
  [/\bargentina\b|\bbuenos aires\b/i, [-180, -180]],
  [/\bmexico\b|\bmexico city\b/i, [-480, -360]],
  [/\bunited states\b|\busa\b|\bnew york\b|\bsan francisco\b|\bseattle\b|\baustin\b|\bchicago\b|\bboston\b|\blos angeles\b|\bdenver\b|\batlanta\b|\bdallas\b/i, [-600, -240]],
  [/\bcanada\b|\btoronto\b|\bvancouver\b|\bmontreal\b/i, [-480, -210]],
  [/\bsouth africa\b|\bcape town\b|\bjohannesburg\b/i, [120, 120]],
  [/\bnigeria\b|\blagos\b|\babuja\b/i, [60, 60]],
  [/\bkenya\b|\bnairobi\b/i, [180, 180]],
  [/\begypt\b|\bcairo\b/i, [120, 120]],
];

/** Plausible UTC-offset range (minutes) for a place string, or null. */
export function placeOffsetRange(place: string): [number, number] | null {
  for (const [re, range] of PLACE_OFFSET_RANGES) {
    if (re.test(place)) return range;
  }
  return null;
}

/** Slack (minutes) allowed outside a place's range before it counts as a
 *  conflict — wide enough to absorb a sleep-schedule shift or a border town. */
export const TIMEZONE_CONFLICT_SLACK_MINUTES = 180;

/**
 * Does the posting-time fit conflict with a stated place? True only when the
 * place is known AND the fit sits more than the slack outside its plausible
 * offset range. Pure.
 */
export function timezoneConflictsWithPlace(offsetMinutes: number, place: string): boolean {
  const range = placeOffsetRange(place);
  if (!range) return false;
  return offsetMinutes < range[0] - TIMEZONE_CONFLICT_SLACK_MINUTES ||
    offsetMinutes > range[1] + TIMEZONE_CONFLICT_SLACK_MINUTES;
}
