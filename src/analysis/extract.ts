/**
 * Deterministic identifier extraction.
 *
 * The LLM agents sometimes paraphrase obvious leaks away ("the bio shows an
 * email" instead of citing the email), so we run a regex pass over the Reddit
 * corpus (and the report text) and surface the raw hits. This guarantees that
 * any concrete email or cross-platform handle present in the data ends up
 * visible in the report regardless of model behavior — these are the strongest,
 * non-negotiable cross-platform keys for identity resolution.
 *
 * Adapted from the defensive "deanonymizer" reference project's regex pass.
 */

export interface SocialHandle {
  platform: string;
  handle: string;
  url: string;
}

export interface DirectIdentifiers {
  emails: string[];
  socialHandles: SocialHandle[];
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Cross-platform handle comparison key: lowercase with the platform-typical
 * separators removed. The same person is `john.doe` on Instagram, `john_doe`
 * on X, `johndoe` on GitHub — separator drift is the most common reason a real
 * cross-platform cluster fails an exact-string match. Also strips a leading @.
 */
export function normalizeHandleKey(handle: string): string {
  return handle.replace(/^@/, "").toLowerCase().replace(/[._-]+/g, "");
}

const SOCIAL_PATTERNS: Array<{
  platform: string;
  pattern: RegExp;
  reject?: RegExp;
}> = [
  {
    platform: "linkedin",
    pattern: /https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/([A-Za-z0-9_-]+)/gi,
  },
  {
    platform: "x",
    pattern:
      /https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)(?=\b|\/|$)/gi,
    reject:
      /^(home|search|explore|intent|share|hashtag|notifications|messages|settings|i|compose|login|signup|tos|privacy|about)$/i,
  },
  {
    platform: "github",
    pattern:
      /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})(?=\b|\/|$)/gi,
    reject:
      /^(issues|pull|search|trending|marketplace|orgs|topics|collections|notifications|settings|new|features|pricing|enterprise|sponsors|readme|about|contact|login|join|signup|security|nonprofit|customer-stories|events|codespaces|copilot)$/i,
  },
  {
    platform: "youtube",
    pattern:
      /https?:\/\/(?:www\.)?youtube\.com\/(?:@|channel\/|user\/|c\/)([A-Za-z0-9_-]+)/gi,
  },
  {
    platform: "instagram",
    pattern:
      /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)(?=\b|\/|$)/gi,
    reject: /^(p|reel|tv|accounts|explore|stories|about|developer)$/i,
  },
  {
    platform: "bluesky",
    pattern: /https?:\/\/(?:www\.)?bsky\.app\/profile\/([A-Za-z0-9_.:-]+)/gi,
  },
  {
    platform: "reddit",
    pattern:
      /https?:\/\/(?:www\.|old\.)?reddit\.com\/(?:u|user)\/([A-Za-z0-9_-]+)/gi,
  },
  {
    platform: "hackernews",
    pattern: /https?:\/\/news\.ycombinator\.com\/user\?id=([A-Za-z0-9_-]+)/gi,
  },
  {
    platform: "telegram",
    pattern: /https?:\/\/(?:www\.)?t\.me\/([A-Za-z0-9_]+)/gi,
    reject: /^(joinchat|s)$/i,
  },
  {
    platform: "gitlab",
    pattern:
      /https?:\/\/(?:www\.)?gitlab\.com\/([A-Za-z0-9][A-Za-z0-9_-]+)(?=\b|\/|$)/gi,
    reject: /^(explore|help|users|projects|search|public|dashboard|admin)$/i,
  },
  {
    platform: "stackoverflow",
    pattern: /https?:\/\/stackoverflow\.com\/users\/(\d+)/gi,
  },
  {
    platform: "mastodon",
    pattern:
      /https?:\/\/(mastodon\.[a-z.]+|mstdn\.[a-z.]+|fosstodon\.org|hachyderm\.io|infosec\.exchange)\/@([A-Za-z0-9_]+)/gi,
  },
];

/** Replace common email obfuscation patterns with the canonical form. */
export function deobfuscateEmails(input: string): string {
  return input
    .replace(/\s*\[\s*at\s*\]\s*/gi, "@")
    .replace(/\s*\(\s*at\s*\)\s*/gi, "@")
    .replace(/\s+at\s+(?=[A-Za-z0-9.-]+\s*(?:\[|\()?\s*dot)/gi, "@")
    .replace(/\s*\[\s*dot\s*\]\s*/gi, ".")
    .replace(/\s*\(\s*dot\s*\)\s*/gi, ".")
    .replace(/\s+dot\s+/gi, ".");
}

/** Pull every email from `text`, de-obfuscated, lowercase, deduped. */
export function extractEmails(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const canon = deobfuscateEmails(text);
  for (const m of canon.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase();
    if (e.endsWith("@users.noreply.github.com")) continue;
    if (e.endsWith("@example.com")) continue;
    if (e.endsWith("@email.com")) continue;
    // Reject domain literals like 0.0.0 or 1.2.3 — common false positives.
    if (/^\d+(\.\d+)*$/.test(e.split("@")[1])) continue;
    out.add(e);
  }
  return [...out];
}

/** Pull cross-platform social handles from URLs in `text`. */
export function extractSocialHandles(text: string): SocialHandle[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: SocialHandle[] = [];
  for (const { platform, pattern, reject } of SOCIAL_PATTERNS) {
    // `matchAll` advances lastIndex on global regexes, so reset before reuse.
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const baseHandle = platform === "mastodon" ? m[2] : m[1];
      const handle = platform === "mastodon" ? `${m[2]}@${m[1]}` : m[1];
      if (reject?.test(baseHandle)) continue;
      const key = `${platform}:${handle.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ platform, handle, url: m[0] });
    }
  }
  return out;
}

/**
 * Run extraction over a corpus of texts, dedupe, and drop the audited Reddit
 * account so we don't "discover" the handle we were given.
 */
export function extractDirectIdentifiers(
  texts: string[],
  auditedUsername?: string,
): DirectIdentifiers {
  const corpus = texts.join("\n\n");
  const emails = extractEmails(corpus);
  let handles = extractSocialHandles(corpus);

  if (auditedUsername) {
    const audited = auditedUsername.toLowerCase();
    handles = handles.filter((h) => {
      if (h.platform === "reddit" || h.platform === "hackernews") {
        return h.handle.toLowerCase() !== audited;
      }
      return true;
    });
  }

  return { emails, socialHandles: handles };
}

/** Render a "direct identifiers extracted" markdown block (concrete leaks). */
export function renderDirectIdentifiersBlock(
  di: DirectIdentifiers | undefined,
): string {
  if (!di) return "";
  if (di.emails.length === 0 && di.socialHandles.length === 0) return "";

  const lines: string[] = [];
  lines.push(`## Direct Identifiers Extracted`);
  lines.push("");
  lines.push(
    `*Concrete leaks pulled by regex from the item bodies and report text — these always surface regardless of LLM behavior.*`,
  );
  lines.push("");

  if (di.emails.length > 0) {
    lines.push(`**Emails**`);
    for (const e of di.emails) lines.push(`- ✉ \`${e}\``);
    lines.push("");
  }

  if (di.socialHandles.length > 0) {
    lines.push(`**Cross-platform handles**`);
    lines.push("");
    lines.push(`| Platform | Handle | URL |`);
    lines.push(`|----------|--------|-----|`);
    for (const h of di.socialHandles) {
      lines.push(`| ${h.platform} | \`${h.handle}\` | ${h.url} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Render identifiers that appear ONLY in model text (not in the deterministic
 *  extraction) as a clearly-labeled "unverified" block. Returns "" when the
 *  model mentioned nothing beyond what the deterministic layers already
 *  captured. Keeps hallucinated/paraphrased values visibly separate from
 *  verified leaks. */
export function renderModelMentionedBlock(
  modelIds: DirectIdentifiers | undefined,
  deterministicIds: DirectIdentifiers | undefined,
): string {
  if (!modelIds) return "";
  const det = new Set<string>([
    ...(deterministicIds?.emails ?? []),
    ...(deterministicIds?.socialHandles ?? []).map((h) => `${h.platform}:${h.handle.toLowerCase()}`),
  ]);
  const emails = modelIds.emails.filter((e) => !det.has(e));
  const handles = modelIds.socialHandles.filter(
    (h) => !det.has(`${h.platform}:${h.handle.toLowerCase()}`),
  );
  if (emails.length === 0 && handles.length === 0) return "";
  const lines: string[] = [];
  lines.push(`## Model-Mentioned Identifiers (Unverified)`);
  lines.push(
    `*These identifiers appear ONLY in the model's narrative report, not in the deterministic corpus/web/GitHub extraction. Treat as leads to verify, not as confirmed leaks — the model may paraphrase or invent them.*`,
  );
  lines.push("");
  for (const e of emails) lines.push(`- ✉ (model-mentioned) \`${e}\``);
  for (const h of handles) lines.push(`- (model-mentioned) ${h.platform}: \`${h.handle}\` — ${h.url}`);
  return lines.join("\n");
}
