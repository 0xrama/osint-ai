/**
 * Compact sub-agent leads digest.
 *
 * The full ground-truth renderers (renderWebContextForPrompt et al.) are sized
 * for the synthesis agent, which reasons about leads as its primary input. The
 * three domain sub-agents have a different job — analyze raw Reddit items — so
 * they get this much smaller projection instead: just enough of each lead
 * (bridge owners, clusters, emails, GitHub leaks, Twitter profiles) for a
 * sub-agent to CONNECT something it spots in the corpus ("a Discord handle",
 * "a name fragment") to a verified anchor. Pure projection over the pass
 * result types — no LLM, no fetch, no Date.now — so the same input always
 * renders the identical string.
 */

import { rankHandles, type WebSweepResult } from "./web-sweep.ts";
import type { GitHubPassResult } from "./github-pass.ts";
import type { TwitterPassResult } from "./twitter-pass.ts";

/** Hard character budget for the digest. Sub-agent prompts are chunk-budgeted;
 *  the digest is deliberately tiny and constant per run so it can sit outside
 *  that math (see deep-analysis.ts). */
const MAX_DIGEST_CHARS = 2500;

/** Inputs are the raw pass results; each is optional because any pass may have
 *  been skipped (no Firecrawl, no GITHUB_TOKEN path, --twitter off). */
export interface LeadsDigestInput {
  username: string;
  webSweep?: WebSweepResult;
  gitHub?: GitHubPassResult;
  twitter?: TwitterPassResult;
}

const TIER_ORDER: Record<string, number> = {
  bridge: 0,
  "cross-platform cluster": 1,
  "username match": 2,
  "single platform": 3,
};

/** Deterministic comparator: tier, then platform count, then plain string
 *  order (NOT localeCompare — locale ordering varies by environment, which
 *  would break byte-identical re-renders). */
function compareRanked(a: { handle: string; tier: string; platformCount: number }, b: { handle: string; tier: string; platformCount: number }): number {
  const ta = TIER_ORDER[a.tier] ?? 9;
  const tb = TIER_ORDER[b.tier] ?? 9;
  if (ta !== tb) return ta - tb;
  if (a.platformCount !== b.platformCount) return b.platformCount - a.platformCount;
  return a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0;
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Render the compact ground-truth digest for domain sub-agent prompts.
 *
 * Why a separate renderer (vs reusing the synthesis one): sub-agents analyze
 * raw items, so the digest prioritizes CONNECTABLE anchors (handles, names,
 * employers, emails) over the search-strategy instructions the synthesis
 * prompt needs. Returns "" when no pass produced a lead, so callers can skip
 * the injection entirely.
 */
export function renderSubAgentLeadsDigest(input: LeadsDigestInput): string {
  const lines: string[] = [];

  const sweep = input.webSweep;
  if (sweep) {
    const ranked = rankHandles(sweep.identifiers.socialHandles, sweep.username, sweep.bridgeEvidence);
    const sorted = [...ranked].sort(compareRanked);

    const bridges = sorted.filter((r) => r.bridge).slice(0, 4);
    if (bridges.length > 0) {
      lines.push("BRIDGE OWNERS — the subject's CURRENT identity handle(s): a page owned by this handle mentions the audited username (stale cross-reference from a handle rename).");
      for (const r of bridges) {
        lines.push(`- ${r.handle} [tier: ${r.tier}; ${r.platforms.join(", ")}] ${r.urls[0] ?? ""}`);
      }
      lines.push("");
    }

    const clusters = sorted.filter((r) => !r.bridge && r.tier === "cross-platform cluster").slice(0, 4);
    if (clusters.length > 0) {
      lines.push("CROSS-PLATFORM CLUSTERS — same handle reused on 2+ platforms (strong same-person signal):");
      for (const r of clusters) {
        lines.push(`- ${r.handle} — ${r.platforms.join(", ")}`);
      }
      lines.push("");
    }

    const emails = sweep.identifiers.emails.slice(0, 4);
    if (emails.length > 0) {
      lines.push("EMAILS (found on scraped pages; count = distinct URLs seen on):");
      const sources = sweep.identifierSources?.emails;
      for (const e of emails) {
        const n = sources?.[e]?.length ?? sources?.[e.toLowerCase()]?.length ?? 0;
        lines.push(`- ${e} — ${n} URL(s)`);
      }
      lines.push("");
    }
  }

  const gh = input.gitHub;
  if (gh) {
    // Same leak definition as renderGitHubContextForPrompt: any profile field
    // that names a real person, or a commit author identity.
    const withLeaks = gh.identities
      .filter((id) => id.name || id.email || id.blog || id.commitAuthors.length > 0 || id.company || id.location || id.twitterUsername)
      .sort((a, b) => compareString(a.login, b.login))
      .slice(0, 3);
    if (withLeaks.length > 0) {
      lines.push("GITHUB IDENTITIES WITH LEAKS (GitHub REST API — verified profile fields):");
      for (const id of withLeaks) {
        const fields = [
          id.name ? `name "${id.name}"` : "",
          id.company ? `company ${id.company}` : "",
          id.location ? `location ${id.location}` : "",
          id.blog ? `blog ${id.blog}` : "",
          id.email ? `email ${id.email}` : "",
          id.twitterUsername ? `twitter @${id.twitterUsername}` : "",
        ].filter(Boolean).join(", ");
        lines.push(`- ${id.login}${fields ? `: ${fields}` : ""}`);
        for (const ca of id.commitAuthors.slice(0, 2)) {
          lines.push(`    commit author: "${ca.name}${ca.email ? ` <${ca.email}>` : ""}" (${ca.repo})`);
        }
      }
      lines.push("");
    }
  }

  const tw = input.twitter;
  if (tw) {
    const withProfiles = tw.results.filter((r) => r.profile).slice(0, 3);
    for (const r of withProfiles) {
      const p = r.profile!;
      lines.push(`TWITTER PROFILE: @${p.screenName} — "${p.name}"${p.url ? `, website ${p.url}` : ""}`);
      const alt = r.altCandidates[0];
      if (alt) {
        lines.push(`    ALT-ACCOUNT CANDIDATE: @${alt.profile.screenName} — "${alt.profile.name}"${alt.profile.url ? `, website ${alt.profile.url}` : ""}`);
      }
    }
    if (withProfiles.length > 0) {
      lines.push("");
    }
  }

  if (lines.length === 0) return "";

  const header = [
    "=== DETERMINISTIC LEADS (verified by pre-analysis passes — ground truth) ===",
    "Use these as verified anchors: when corpus evidence you find (a handle, name,",
    "employer, or location) matches a lead below, CONNECT it and cite the connection",
    "explicitly. Do not re-derive these leads or speculate beyond them.",
    "",
  ];
  const footer = ["=== END DETERMINISTIC LEADS ==="];

  // Hard cap: drop trailing body lines (never the header/footer) until the
  // whole digest fits. Deterministic line-drop, no slicing mid-line.
  let body = lines;
  let text = [...header, ...body, ...footer].join("\n");
  while (text.length > MAX_DIGEST_CHARS && body.length > 0) {
    body = body.slice(0, -1);
    text = [...header, ...body, ...footer].join("\n");
  }
  // Last resort (pathological single-line overflow): hard slice.
  if (text.length > MAX_DIGEST_CHARS) {
    text = text.slice(0, MAX_DIGEST_CHARS);
  }
  return text;
}
