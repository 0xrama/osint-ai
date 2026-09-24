/**
 * Deterministic relevance ranking for the deep-analysis sub-agent buckets.
 *
 * The multi-agent pipeline used to blow up on big accounts because every
 * unmatched item was copied into every domain bucket (the "fanout"), and each
 * bucket then churned through many sequential LLM chunks. This module is the
 * deterministic countermeasure (same philosophy as extract.ts / web-sweep.ts):
 * score every item by how much identity signal it likely carries, sort each
 * domain bucket by that score, and keep only the top N — so a 7,000-item
 * history costs ~1 LLM chunk per domain instead of dozens.
 *
 * Signal hierarchy (highest first):
 *   direct identifier regex hit  — an item that literally contains an email or
 *                                  a cross-platform profile URL; the strongest
 *                                  possible lead (reuses extract.ts patterns).
 *   keyword newsworthiness       — rare, high-intent phrases ("my real name",
 *                                  "years old", "i work at") outrank common
 *                                  noise words ("job", "work") via an IDF-like
 *                                  weight derived from each domain's keyword
 *                                  list.
 *   deleted/removed              — deleted content is often the most revealing.
 *   subreddit + domain affinity  — membership in a domain's target subs.
 *   recency                      — newer items reflect current identity.
 *
 * Items below a minimum signal floor (very short + one common-keyword hit +
 * nothing else) are dropped even when the bucket is under the cap.
 */

import type { FilteredItem } from "../types.ts";
import { normalizeHandleKey } from "./extract.ts";

// ── Scoring weights ───────────────────────────────────────────────────────

const W_DIRECT_IDENTIFIER = 40;
const W_DELETED = 25;
const W_SUBREDDIT = 15;
const W_RECENCY_MAX = 15;
const W_KEYWORD_CAP = 30;

/** Drop an item entirely when it can't beat this floor (see shouldKeep). */
export const MIN_SIGNAL_SCORE = 14;

/**
 * Default per-domain item cap. Deliberately aligned with
 * MAX_ITEMS_PER_AGENT_CHUNK (180) in deep-analysis.ts: a value larger than the
 * chunk size would force a 180+rest split on every full bucket, resurrecting
 * the multi-chunk + consolidation-call amplification this module exists to
 * kill. Override with DEEP_MAX_ITEMS_PER_DOMAIN.
 */
export const DEFAULT_MAX_ITEMS_PER_DOMAIN = 180;

export function maxItemsPerDomain(): number {
  const raw = Number(process.env.DEEP_MAX_ITEMS_PER_DOMAIN);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_ITEMS_PER_DOMAIN;
}

/**
 * DEEP_EXHAUSTIVE=1 restores the old unbounded coverage: no per-domain cap and
 * no signal floor. Exists for the rare case where the operator accepts a long
 * scan in exchange for sending every surviving item to the sub-agents.
 */
export function isExhaustive(): boolean {
  const v = process.env.DEEP_EXHAUSTIVE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// ── Direct-identifier patterns (kept in sync with extract.ts) ─────────────

const SCORE_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const SCORE_HANDLE_RES: RegExp[] = [
  /https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/i,
  /https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/[A-Za-z0-9_]+/i,
  /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}/i,
  /https?:\/\/(?:www\.)?youtube\.com\/(?:@|channel\/|user\/|c\/)[A-Za-z0-9_-]+/i,
  /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.]+/i,
  /https?:\/\/(?:www\.)?bsky\.app\/profile\/[A-Za-z0-9_.:-]+/i,
  /https?:\/\/news\.ycombinator\.com\/user\?id=[A-Za-z0-9_-]+/i,
  /https?:\/\/(?:www\.)?t\.me\/[A-Za-z0-9_]+/i,
  /https?:\/\/(?:www\.)?gitlab\.com\/[A-Za-z0-9][A-Za-z0-9_-]+/i,
  /https?:\/\/stackoverflow\.com\/users\/\d+/i,
];

function hasDirectIdentifier(text: string): boolean {
  return SCORE_EMAIL_RE.test(text) || SCORE_HANDLE_RES.some((re) => re.test(text));
}

// ── Keyword newsworthiness (IDF-like weighting over the domain's own list) ──

export interface KeywordWeight {
  kw: string;
  weight: number;
}

/**
 * Weight each keyword by rarity inside its own domain list: rare, high-intent
 * phrases score high; generic words present in huge numbers score low. This is
 * a fixed per-domain table computed once (the list itself is the corpus —
 * "my real name" appears once while "work" is one of dozens of common terms).
 */
export function buildKeywordWeights(keywords: string[]): KeywordWeight[] {
  const seen = new Map<string, number>();
  for (const raw of keywords) {
    const kw = raw.toLowerCase().trim();
    if (!kw) continue;
    seen.set(kw, (seen.get(kw) ?? 0) + 1);
  }
  const total = Math.max(1, seen.size);
  const out: KeywordWeight[] = [];
  for (const [kw, count] of seen) {
    const idf = Math.max(0, Math.log(total / count)); // 0 for uniques in a big list
    // Multi-word phrases are inherently more specific — floor them higher than
    // single generic words so "my real name" >> "work".
    const phraseBonus = kw.includes(" ") ? 6 : 0;
    out.push({ kw, weight: 4 + idf + phraseBonus });
  }
  // Longest/most specific first so the substring scan hits specific phrases
  // before their single-word components.
  return out.sort((a, b) => b.kw.length - a.kw.length);
}

// ── Public scoring API ────────────────────────────────────────────────────

export interface RankContext {
  /** Domain keyword weights (buildKeywordWeights output). */
  keywordWeights: KeywordWeight[];
  /** Domain target subreddits (lowercased). */
  subreddits: string[];
  /** Lowercased handle keys (normalizeHandleKey) of the audited username and
   *  any ground-truth handles from the deterministic passes — items that name
   *  these get a direct-identifier-style boost. */
  knownHandleKeys: string[];
}

export function scoreItem(item: FilteredItem, ctx: RankContext): number {
  const body = item.body ?? "";
  const title = item.title ?? "";
  const text = `${body} ${title}`.toLowerCase();
  let score = 0;

  if (hasDirectIdentifier(text)) score += W_DIRECT_IDENTIFIER;
  if (item.is_deleted || item.is_removed) score += W_DELETED;

  const sub = item.subreddit.toLowerCase();
  if (ctx.subreddits.some((s) => sub === s || sub.includes(s))) score += W_SUBREDDIT;

  let kwScore = 0;
  for (const { kw, weight } of ctx.keywordWeights) {
    if (text.includes(kw)) {
      kwScore += weight;
      if (kwScore >= W_KEYWORD_CAP) { kwScore = W_KEYWORD_CAP; break; }
    }
  }
  score += kwScore;

  // Known-handle mention (the audited username / ground-truth handles appear
  // verbatim in the text) — strong cross-reference signal even without a URL.
  // Length guard >= 4: a 3-char key ("pix") substring-matches half of English.
  if (ctx.knownHandleKeys.some((k) => k.length >= 4 && text.includes(k))) {
    score += W_DIRECT_IDENTIFIER;
  }

  // Recency: full marks for <90 days, linear decay to 0 at 5 years.
  const ageMs = Date.now() - item.created_utc * 1000;
  const ageDays = ageMs / 86_400_000;
  if (ageDays <= 90) score += W_RECENCY_MAX;
  else {
    const frac = Math.max(0, 1 - (ageDays - 90) / (5 * 365 - 90));
    score += Math.round(frac * W_RECENCY_MAX);
  }

  return score;
}

/**
 * Sort a domain bucket by relevance and keep at most `cap` items. Deleted
 * items are never dropped by the cap (they float to the top via W_DELETED and
 * are pinned ahead of the cut line). Also drops items under MIN_SIGNAL_SCORE.
 * Returns the surviving items plus a per-domain drop count for logging.
 */
export function rankAndCapBucket(
  items: FilteredItem[],
  ctx: RankContext,
  cap: number,
): { kept: FilteredItem[]; droppedByCap: number; droppedByFloor: number } {
  // Exhaustive mode: no floor, no cap — the pre-ranking behavior.
  if (isExhaustive()) {
    return {
      kept: [...items].sort((a, b) => b.created_utc - a.created_utc),
      droppedByCap: 0,
      droppedByFloor: 0,
    };
  }

  const scored = items.map((item) => ({ item, score: scoreItem(item, ctx) }));

  const floorKept = scored.filter(({ item, score }) => {
    if (item.is_deleted || item.is_removed) return true; // never floor-drop deleted
    return score >= MIN_SIGNAL_SCORE;
  });
  const droppedByFloor = scored.length - floorKept.length;

  floorKept.sort((a, b) => b.score - a.score || b.item.created_utc - a.item.created_utc);

  // Pin deleted items — but BOUND the pin. An account that mass-deleted
  // thousands of items (PowerDeleteSuite-style) must not put all of them in
  // every bucket; that would resurrect the multi-chunk blowup the cap exists
  // to kill. Rank deleted items among themselves (identifier-bearing ones win
  // via their +40 identifier boost on top of +25 deleted) and pin at most
  // `cap` of them; the rest count against the cap like any other item.
  const deleted = floorKept.filter(({ item }) => item.is_deleted || item.is_removed);
  const rest = floorKept.filter(({ item }) => !(item.is_deleted || item.is_removed));
  const pinnedDeleted = deleted.slice(0, cap);
  const unpinnedDeleted = deleted.slice(cap);
  const roomForRest = Math.max(0, cap - pinnedDeleted.length);
  const kept = [...pinnedDeleted, ...rest.slice(0, roomForRest)].map(({ item }) => item);
  // droppedByCap covers both unpinned deleted and over-cap regular items.
  const droppedByCap = floorKept.length - kept.length;
  if (unpinnedDeleted.length > 0) {
    console.warn(
      `[rank] ${unpinnedDeleted.length} deleted item(s) exceeded the per-domain pin budget (cap=${cap}) and were capped out.`,
    );
  }

  // Restore newest-first presentation for the sub-agent prompt.
  kept.sort((a, b) => b.created_utc - a.created_utc);
  return { kept, droppedByCap, droppedByFloor };
}

/** Normalize a raw handle into the comparison key used for known-handle boosts. */
export function handleKey(handle: string): string {
  return normalizeHandleKey(handle);
}
