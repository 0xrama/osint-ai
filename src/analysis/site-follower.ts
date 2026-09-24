/**
 * Shallow website link-follower for personal sites / portfolios declared or
 * discovered during research.
 *
 * Fetches the root page, then up to 5 same-origin sub-paths that look
 * identity-relevant (/about, /cv, /resume, /contact, /bio, /portfolio, …),
 * strips each to text, and concatenates. Crucially, it preserves `mailto:` and
 * `http(s)://` href values *before* stripping the HTML — the single biggest
 * leak channel on personal sites (the email lives in the `<a href>`, not the
 * visible text).
 *
 * Exposed to the synthesis / live agents as a `web_follow_site` tool: prefer it
 * over plain `web_scrape` for personal sites because it auto-expands identity
 * sub-pages. Hard limits: text/* only, 10s per request, 2 MB body cap, errors
 * swallowed. JS-rendered SPAs won't work without a headless browser.
 *
 * Adapted from the "deanonymizer" reference project's link-follower.
 */

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 10_000;
const MAX_EXTRA_PAGES = 5;
const MAX_TOTAL_TEXT = 20_000;
const UA = "osint-ai/2.0 (research; site link-follower)";

const IDENTITY_PATH_RE =
  /\/(about|cv|resume|bio|contact|me|home|portfolio|profile|info)(\.html?|\/?$)/i;

export interface FollowedSite {
  url: string;
  text: string;
}

export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return null;
}

/** Minimal HTML entity decoder. */
function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

/**
 * Pull mailto:/http(s) hrefs BEFORE tag-stripping kills them, then strip to
 * text. Emails hiding behind `<a href="mailto:…">` survive the pass this way.
 * The rendered link block pairs each href with its VISIBLE LABEL as a
 * markdown `[label](href)` — that pairing is the anchor-rename bridge
 * signature (a link displaying the old handle that points at the new one).
 */
function extractText(html: string): string {
  // Capture the visible label of each anchor (first label per href wins).
  const labels = new Map<string, string>();
  const labelRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(labelRe)) {
    const href = m[1].trim();
    if (!/^(mailto:|https?:\/\/)/i.test(href) || labels.has(href)) continue;
    const label = decodeEntities(m[2])
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (label) labels.set(href, label);
  }

  const linkRe = /\bhref\s*=\s*["']([^"']+)["']/gi;
  const links = new Set<string>();
  for (const m of html.matchAll(linkRe)) {
    const v = m[1].trim();
    if (/^mailto:/i.test(v) || /^https?:\/\//i.test(v)) {
      links.add(v);
    }
  }

  const withoutTags = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>(?!\n)/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const stripped = decodeEntities(withoutTags)
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (links.size === 0) return stripped;
  const rendered = [...links].map((l) => {
    const label = labels.get(l);
    return label && label !== l ? `[${label}](${l})` : l;
  });
  return `${stripped}\n\nLinks found on page:\n${rendered.join("\n")}`;
}

async function fetchRaw(
  url: string,
): Promise<{ html: string; text: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/(html|plain)/i.test(ct)) return null;

    const reader = res.body?.getReader();
    let html: string;
    if (!reader) {
      html = await res.text();
    } else {
      let received = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          chunks.push(value);
          if (received >= MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            break;
          }
        }
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      html = buf.toString("utf8");
    }
    return { html, text: extractText(html) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sameOriginLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const hrefRe = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi;
  const out = new Set<string>();
  for (const m of html.matchAll(hrefRe)) {
    try {
      const u = new URL(m[1], baseUrl);
      if (u.origin !== base.origin) continue;
      if (u.pathname === base.pathname) continue;
      if (
        /\.(png|jpe?g|gif|webp|svg|ico|css|js|pdf|zip|mp4|mp3)$/i.test(
          u.pathname,
        )
      )
        continue;
      u.hash = "";
      out.add(u.toString());
    } catch {
      // ignore unparseable hrefs
    }
  }
  return [...out];
}

/**
 * Fetch the page at `url`, then crawl up to MAX_EXTRA_PAGES same-origin
 * sub-paths, prioritizing identity-looking routes (/about, /cv, /resume,
 * /contact, …). Returns the concatenated text, or null if nothing reachable.
 */
export async function followWebsite(
  rawUrl: string,
): Promise<FollowedSite | null> {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;

  const root = await fetchRaw(url);
  if (!root) return null;

  const links = sameOriginLinks(root.html, url);
  // Prioritize identity-looking paths, then preserve the page's own order.
  links.sort((a, b) => {
    const aScore = IDENTITY_PATH_RE.test(a) ? 0 : 1;
    const bScore = IDENTITY_PATH_RE.test(b) ? 0 : 1;
    return aScore - bScore;
  });

  const parts: string[] = [`=== ${url} ===\n${root.text}`];
  let total = root.text.length;

  for (const sub of links.slice(0, MAX_EXTRA_PAGES)) {
    if (total >= MAX_TOTAL_TEXT) break;
    const r = await fetchRaw(sub);
    if (!r?.text) continue;
    const slice = r.text.slice(0, Math.max(0, MAX_TOTAL_TEXT - total));
    if (!slice) break;
    parts.push(`=== ${sub} ===\n${slice}`);
    total += slice.length;
  }

  const text = parts.join("\n\n");
  if (text.trim().length <= 80) return null;
  return { url, text };
}
