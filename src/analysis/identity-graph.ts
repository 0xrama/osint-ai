/**
 * Person-level identity graph — the ROADMAP #1 keystone.
 *
 * Every deterministic pass discovers pieces of the same picture: the web
 * sweep finds rename bridges and cross-platform handle clusters, handle-drift
 * finds confusable re-spellings, the GitHub pass finds emails/names/sites
 * behind a login, the Twitter pass finds display names and profile sites,
 * and the corpus itself contains verbal handle disclosures. Until now those
 * lived in separate structures, and corroboration clustered by signal VALUE
 * — nothing answered the question that actually matters: "which
 * handles/emails/names belong to ONE person, and which handles are provably
 * someone else (namesakes)?".
 *
 * This module is a PURE PROJECTION over the existing pass results: no fetch,
 * no LLM, no clock. It fuses the passes into a graph of identifier nodes and
 * evidence edges, then collapses the edges into person entities via
 * connected components. The component containing the audited username is
 * the SUBJECT; every other component is a namesake candidate — a handle that
 * matched the username string somewhere but that nothing ties to the audited
 * identity. That negative result is as valuable as the fusion: it is what
 * lets the synthesis agent attribute (and refuse to attribute) with ground
 * truth instead of string similarity vibes.
 *
 * Design choices worth knowing:
 *   - One handle node per SEPARATOR-normalized key (john.doe ≈ john_doe ≈
 *     johndoe), mirroring the sweep's clustering. Cross-platform reuse of a
 *     handle string is expressed by the node's `platforms[]`, NOT by edges —
 *     an edge exists only when there is EVIDENCE of a relationship (a
 *     bridge, a drift spelling, a disclosure, a profile field).
 *   - Divergence from `rankHandles`: the sweep merges drift spellings
 *     (fixtureveil / fixtureve1l) into one cluster; the graph keeps them as
 *     SEPARATE nodes joined by an explicit `drift` edge, because the graph's
 *     job is to expose the evidence structure, not to hide it inside a
 *     merged row. `rankHandles` still runs over the merged universe so node
 *     display spellings match the sweep's chosen (most-seen) variant.
 *   - Merge policy for persons: edges with strength ≥ 0.6 fuse nodes, EXCEPT
 *     `site-of` — a profile link proves the site belongs to the handle's
 *     owner but sites are too cheap to merge identities around. `name-of`
 *     DOES merge at 0.8: a real-name leak on a platform profile is a strong
 *     person-level join.
 *   - Disclosure edges point AT the audited-username node: the subject
 *     verbally disclosed the handle in their own corpus, which ties that
 *     handle to the audited identity.
 */

import { normalizeHandleKey, type DirectIdentifiers, type SocialHandle } from "./extract.ts";
import { isDriftVariant } from "./handle-drift.ts";
import { rankHandles, type WebSweepResult } from "./web-sweep.ts";
import type { GitHubPassResult } from "./github-pass.ts";
import type { TwitterPassResult } from "./twitter-pass.ts";

/* ────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────── */

export interface IdentityGraphNode {
  /** Stable id: `<kind>:<normalized value>` (handle:johndoe, email:a@b.c). */
  id: string;
  kind: "handle" | "email" | "name" | "site";
  /** Best (most-seen) spelling of the identifier. */
  value: string;
  /** Platforms the handle was seen on (cross-platform reuse lives HERE). */
  platforms: string[];
  /** Provenance URLs, capped at 3. A value without provenance is a lead. */
  sources: string[];
}

export type IdentityGraphEdgeKind =
  | "rename"
  | "anchor-rename"
  | "cluster"
  | "drift"
  | "disclosure"
  | "email-of"
  | "name-of"
  | "site-of";

export interface IdentityGraphEdge {
  from: string;
  to: string;
  kind: IdentityGraphEdgeKind;
  /** 0..1 — how strongly the evidence ties `from` and `to` together. */
  strength: number;
  /** Evidence URLs, capped at 3. */
  evidence: string[];
}

export interface PersonEntity {
  id: string;
  handleNodes: string[];
  emailNodes: string[];
  nameNodes: string[];
  confidence: "high" | "medium" | "low";
  /** Strongest edge strength inside the component (0 when singleton). */
  strongestEdge: number;
  /** True for the component containing the audited username's node. */
  isSubject: boolean;
}

export interface IdentityGraph {
  nodes: IdentityGraphNode[];
  edges: IdentityGraphEdge[];
  persons: PersonEntity[];
}

export interface IdentityGraphInput {
  username: string;
  webSweep?: WebSweepResult;
  gitHub?: GitHubPassResult;
  twitter?: TwitterPassResult;
  corpusIdentifiers?: DirectIdentifiers;
  /** Corpus items scanned for verbal handle disclosures (permalink = evidence). */
  corpusTexts?: Array<{ text: string; permalink?: string }>;
}

/* ────────────────────────────────────────────────────────────────────────
 * Local mirrors of module-private helpers
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Mirror of web-sweep.ts `RESERVED_SEED_WORDS` (module-private there; this
 * file may not edit it). Platform plumbing ("github", "download", …) must
 * never become graph nodes: a node named `github` would word-match on every
 * page and manufacture fake edges wholesale. Keep in sync with web-sweep.ts.
 */
const RESERVED_SEED_WORDS = new Set([
  "github", "gitlab", "git", "twitter", "x", "instagram", "linkedin", "reddit",
  "telegram", "youtube", "discord", "twitch", "medium", "substack", "tiktok",
  "facebook", "threads", "mastodon", "bluesky", "bsky", "snapchat", "pinterest",
  "download", "downloads", "trending", "trending_repos", "explore", "search",
  "login", "signup", "signin", "home", "about", "contact", "blog", "docs",
  "developer", "status", "events", "universe", "help", "support", "settings",
  "notifications", "new", "org", "orgs", "com", "www", "app", "api", "mail",
]);

/** Mirror of web-sweep.ts `isSeededHandleWord` (same reserved-word hygiene). */
function isReservedKey(key: string): boolean {
  return key.length < 3 || RESERVED_SEED_WORDS.has(key);
}

/** Mirror of github-pass.ts `isContentlessEmail` — GitHub-generated mailboxes
 * carry no identity and must not become email nodes. */
function isContentlessEmail(email: string): boolean {
  return /^((noreply|no-reply|donotreply)@|[^@]{0,2}@)|users\.noreply\.github\.com$/i.test(email);
}

/**
 * Mirror of twitter-pass.ts `nameLooksReal`: ≥2 alphabetic tokens, at least
 * one capitalized, and not just the handle re-spelled. "Rohan Sharma" yes;
 * "0x crypto whale" no. Used so Twitter display-name edges only fire for
 * names that actually look like a person.
 */
function looksLikeRealName(name: string, handle: string): boolean {
  const tokens = name
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-zÀ-ž'-]/g, ""))
    .filter((t) => t.length >= 2);
  if (tokens.length < 2) return false;
  const stem = normalizeHandleKey(handle);
  if (tokens.join("").toLowerCase() === stem) return false;
  return tokens.some((t) => /^[A-ZÀ-Ž]/.test(t));
}

/* ────────────────────────────────────────────────────────────────────────
 * Small utilities
 * ──────────────────────────────────────────────────────────────────────── */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary token match that rejects URL-fragment false positives
 * (`/handle/i/x`, `?id=handle`): the char before must not be a word char or
 * a URL metachar, and the char after must not be a word char. */
function mentionsHandleToken(text: string, handle: string): number {
  const re = new RegExp(`(^|[^\\w/=&?])(${escapeRegExp(handle)})(?![\\w])`, "i");
  const m = re.exec(text);
  return m ? m.index + m[1].length : -1;
}

function snippetAround(text: string, idx: number, len: number, radius = 60): string {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + len + radius);
  const core = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${core}${end < text.length ? "…" : ""}`.slice(0, 120);
}

/** Stable node key for a personal-site URL (protocol/www/trailing-slash stripped). */
function siteKey(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const path = u.pathname.replace(/\/+$/, "");
    const key = `${u.hostname.toLowerCase().replace(/^www\./, "")}${path}`;
    return key || null;
  } catch {
    return null;
  }
}

function nameKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/* Edge strengths — fixed by edge semantics (see module JSDoc). */
const STRENGTH = {
  rename: 0.7,
  anchorRename: 1.0,
  drift: 0.6,
  disclosure: 0.8,
  emailOf: 0.9,
  emailLocalPart: 0.6,
  nameOf: 0.8,
  siteOf: 0.7,
} as const;

/** Edges below this strength never fuse nodes; `site-of` never fuses. */
const MERGE_MIN_STRENGTH = 0.6;
const NON_MERGING_KINDS = new Set<IdentityGraphEdgeKind>(["site-of"]);

/* ────────────────────────────────────────────────────────────────────────
 * Graph construction
 * ──────────────────────────────────────────────────────────────────────── */

interface HandleBucket {
  key: string;
  variants: string[];
  /** variant -> times seen (drives the display spelling). */
  counts: Map<string, number>;
  platforms: Set<string>;
  urls: string[];
}

/**
 * Build the person-level identity graph as a pure projection over the
 * deterministic pass results. Deterministic: same input → deep-equal output
 * (no clock, no network, no LLM); nodes/edges/persons are sorted by id.
 *
 * Edge semantics shipped:
 *   - `rename` (0.7): a page owned by handle B mentions the target handle —
 *     the stale-badge bridge. Owner (current identity) → target (stale).
 *   - `anchor-rename` (1.0): the strongest bridge variant — a link whose
 *     visible text is the old handle but whose target is a different profile
 *     root. Direction is unambiguous, so is the strength.
 *   - `drift` (0.6): two handle nodes whose normalized keys are digit/letter
 *     drift variants (fixtureveil ↔ fixtureve1l), keys ≥5 chars.
 *   - `disclosure` (0.8): the corpus verbally mentions a discovered handle
 *     (word-boundary, URL-fragment-safe) → edge INTO the audited-username
 *     node, tying the handle to the audited identity.
 *   - `email-of` (0.9 GitHub profile/commit email; 0.6 email local-part
 *     heuristic): email belongs to the handle's owner.
 *   - `name-of` (0.8): real-name leak on a GitHub/Twitter profile.
 *   - `site-of` (0.7): profile blog/website link. Never merges persons.
 */
export function buildIdentityGraph(input: IdentityGraphInput): IdentityGraph {
  const auditedKey = normalizeHandleKey(input.username);
  const auditedId = `handle:${auditedKey}`;
  const sweep = input.webSweep;

  /* ── 1. Merged raw handle universe ───────────────────────────────────
   * Every pass contributes its handles; bridge owners/targets and GitHub
   * logins are added synthetically so their nodes exist even when the sweep
   * extractor never saw a profile page for them. */
  const raw: SocialHandle[] = [];
  const pushRaw = (platform: string, handle: string, url: string): void => {
    if (!handle) return;
    raw.push({ platform, handle, url });
  };
  for (const h of sweep?.identifiers.socialHandles ?? []) pushRaw(h.platform, h.handle, h.url);
  for (const h of input.corpusIdentifiers?.socialHandles ?? []) pushRaw(h.platform, h.handle, h.url);
  for (const h of input.twitter?.identifiers.socialHandles ?? []) pushRaw(h.platform, h.handle, h.url);
  for (const gh of input.gitHub?.identities ?? []) pushRaw("github", gh.login, gh.url);
  for (const res of input.twitter?.results ?? []) {
    if (res.profile) pushRaw("x", res.profile.screenName, `https://x.com/${res.profile.screenName}`);
  }
  if (sweep?.bridgeEvidence) {
    for (const [owner, entries] of Object.entries(sweep.bridgeEvidence)) {
      pushRaw("web", owner, entries[0]?.url ?? "");
      for (const e of entries) {
        if (e.target) pushRaw("web", e.target, e.url);
        if (e.anchorTarget) pushRaw("web", e.anchorTarget, e.url);
      }
    }
  }
  // The audited account itself is always a node (platform: reddit).
  pushRaw("reddit", input.username, `https://reddit.com/user/${input.username.toLowerCase()}`);

  // Dedupe (a handle can arrive from several passes) — order-stable.
  const seenRaw = new Set<string>();
  const rawDeduped = raw.filter((h) => {
    const k = `${h.platform}:${h.handle.toLowerCase()}:${h.url}`;
    if (seenRaw.has(k)) return false;
    seenRaw.add(k);
    return true;
  });

  /* ── 2. Buckets by normalized key (one node per bucket) ─────────────── */
  const buckets = new Map<string, HandleBucket>();
  for (const h of rawDeduped) {
    const key = normalizeHandleKey(h.handle);
    if (!key) continue;
    let b = buckets.get(key);
    if (!b) {
      b = { key, variants: [], counts: new Map(), platforms: new Set(), urls: [] };
      buckets.set(key, b);
    }
    if (!b.variants.includes(h.handle)) b.variants.push(h.handle);
    b.counts.set(h.handle, (b.counts.get(h.handle) ?? 0) + 1);
    b.platforms.add(h.platform);
    if (h.url && !b.urls.includes(h.url)) b.urls.push(h.url);
  }

  // rankHandles over the merged universe: we adopt its chosen display
  // spelling (most-seen variant, drift merges included) so graph node
  // labels match the sweep's report rows. Bucket structure stays ours so
  // drift spellings remain distinct nodes (see module JSDoc).
  const ranked = rankHandles(rawDeduped, input.username, sweep?.bridgeEvidence);
  const primaryDisplay = new Map<string, string>();
  for (const r of ranked) primaryDisplay.set(normalizeHandleKey(r.handle), r.handle);

  /* ── 3. Handle nodes (reserved-word hygiene, audited username exempt) ─ */
  const handleNodes = new Map<string, IdentityGraphNode>();
  for (const [key, b] of buckets) {
    if (isReservedKey(key) && key !== auditedKey) continue;
    let display = primaryDisplay.get(key);
    if (!display || !b.variants.includes(display)) {
      // Most-seen bucket variant; ties break lexicographically (determinism).
      display = [...b.variants].sort(
        (a, c) => (b.counts.get(c) ?? 0) - (b.counts.get(a) ?? 0) || a.localeCompare(c),
      )[0];
    }
    handleNodes.set(key, {
      id: `handle:${key}`,
      kind: "handle",
      value: display,
      platforms: [...b.platforms].sort(),
      sources: b.urls.slice(0, 3),
    });
  }

  /* ── 4. Email nodes (provenance where the passes recorded it) ───────── */
  const emailProvenance = new Map<string, string[]>();
  const addEmail = (email: string, source: string | string[]): void => {
    const lc = email.toLowerCase();
    const srcs = Array.isArray(source) ? source : [source];
    const existing = emailProvenance.get(lc) ?? [];
    for (const s of srcs) if (s && !existing.includes(s)) existing.push(s);
    emailProvenance.set(lc, existing);
  };
  for (const e of sweep?.identifiers.emails ?? []) {
    addEmail(e, sweep?.identifierSources?.emails[e.toLowerCase()] ?? []);
  }
  for (const e of input.corpusIdentifiers?.emails ?? []) addEmail(e, []);
  for (const e of input.twitter?.identifiers.emails ?? []) {
    addEmail(e, input.twitter?.identifierSources.emails[e.toLowerCase()] ?? []);
  }
  for (const gh of input.gitHub?.identities ?? []) {
    const emails = new Set([gh.email ?? "", ...gh.commitAuthors.map((a) => a.email)].filter(Boolean));
    for (const e of emails) if (!isContentlessEmail(e)) addEmail(e, gh.url);
  }

  const emailNodes = new Map<string, IdentityGraphNode>();
  const ensureEmailNode = (email: string): IdentityGraphNode => {
    const lc = email.toLowerCase();
    let n = emailNodes.get(lc);
    if (!n) {
      n = {
        id: `email:${lc}`,
        kind: "email",
        value: email,
        platforms: [],
        sources: (emailProvenance.get(lc) ?? []).slice(0, 3),
      };
      emailNodes.set(lc, n);
    }
    return n;
  };

  // Materialize a node for every email the passes observed — even unjoined
  // ones (they render as unconnected leads; provenance carries their weight).
  for (const lc of emailProvenance.keys()) ensureEmailNode(lc);

  const nameNodes = new Map<string, IdentityGraphNode>();
  const ensureNameNode = (name: string): IdentityGraphNode => {
    const key = nameKey(name);
    let n = nameNodes.get(key);
    if (!n) {
      n = { id: `name:${key}`, kind: "name", value: name.trim(), platforms: [], sources: [] };
      nameNodes.set(key, n);
    }
    return n;
  };

  const siteNodes = new Map<string, IdentityGraphNode>();
  const ensureSiteNode = (url: string): IdentityGraphNode | null => {
    const key = siteKey(url);
    if (!key) return null;
    let n = siteNodes.get(key);
    if (!n) {
      n = { id: `site:${key}`, kind: "site", value: url.trim(), platforms: [], sources: [] };
      siteNodes.set(key, n);
    }
    return n;
  };

  /* ── 5. Edges (deduped by from|to|kind; max strength wins) ──────────── */
  const edgeMap = new Map<string, IdentityGraphEdge>();
  const addEdge = (
    from: string,
    to: string,
    kind: IdentityGraphEdgeKind,
    strength: number,
    evidence: string[],
  ): void => {
    if (from === to) return;
    const dedupeKey = `${from}|${to}|${kind}`;
    const existing = edgeMap.get(dedupeKey);
    if (existing) {
      if (strength > existing.strength) existing.strength = strength;
      for (const e of evidence) {
        if (e && !existing.evidence.includes(e) && existing.evidence.length < 3) existing.evidence.push(e);
      }
      return;
    }
    edgeMap.set(dedupeKey, { from, to, kind, strength, evidence: evidence.filter(Boolean).slice(0, 3) });
  };

  // 5a. rename / anchor-rename: iterate the sweep's bridgeEvidence directly
  // (its raw owner keys match our per-bucket nodes; going through ranked
  // clusters would collapse drift owners into their target and self-loop).
  if (sweep?.bridgeEvidence) {
    for (const [ownerRaw, entries] of Object.entries(sweep.bridgeEvidence)) {
      const owner = handleNodes.get(normalizeHandleKey(ownerRaw));
      if (!owner) continue;
      for (const e of entries) {
        const target = handleNodes.get(normalizeHandleKey(e.target ?? input.username));
        if (!target) continue;
        const isAnchor = e.kind === "anchor-rename";
        addEdge(
          owner.id,
          target.id,
          isAnchor ? "anchor-rename" : "rename",
          isAnchor ? STRENGTH.anchorRename : STRENGTH.rename,
          [e.url],
        );
      }
    }
  }

  // 5b. drift: pairwise digit/letter variant keys (≥5 chars — short handles
  // collide catastrophically), same guard as handle-drift.ts groupDriftKeys.
  const driftKeys = [...handleNodes.keys()].filter((k) => k.length >= 5).sort();
  for (let i = 0; i < driftKeys.length; i++) {
    for (let j = i + 1; j < driftKeys.length; j++) {
      if (isDriftVariant(driftKeys[i], driftKeys[j])) {
        addEdge(`handle:${driftKeys[i]}`, `handle:${driftKeys[j]}`, "drift", STRENGTH.drift, []);
      }
    }
  }

  // 5c. disclosure: the subject verbally mentioned a discovered handle in
  // their own corpus → tie it to the audited identity. Word-boundary scan
  // over every spelling variant; URL fragments (/handle/i/x) never match.
  if (input.corpusTexts?.length) {
    for (const [key, node] of handleNodes) {
      if (key === auditedKey || key.length < 4 || isReservedKey(key)) continue;
      const variants = buckets.get(key)?.variants ?? [node.value];
      const evidence: string[] = [];
      for (const item of input.corpusTexts) {
        for (const variant of variants) {
          const idx = mentionsHandleToken(item.text, variant);
          if (idx >= 0) {
            evidence.push(item.permalink ?? snippetAround(item.text, idx, variant.length));
            break;
          }
        }
        if (evidence.length >= 3) break;
      }
      if (evidence.length > 0) {
        addEdge(node.id, auditedId, "disclosure", STRENGTH.disclosure, evidence);
      }
    }
  }

  // 5d. GitHub profile/commit fields: login → email (0.9), name (0.8), site (0.7).
  for (const gh of input.gitHub?.identities ?? []) {
    const loginNode = handleNodes.get(normalizeHandleKey(gh.login));
    if (!loginNode) continue;
    const emails = new Set([gh.email ?? "", ...gh.commitAuthors.map((a) => a.email)].filter(Boolean));
    for (const e of emails) {
      if (isContentlessEmail(e)) continue;
      addEdge(loginNode.id, ensureEmailNode(e).id, "email-of", STRENGTH.emailOf, [gh.url]);
    }
    const names = new Set(
      [gh.name ?? "", ...gh.commitAuthors.map((a) => a.name)].filter((s) => s.trim().length > 0),
    );
    for (const n of names) {
      addEdge(loginNode.id, ensureNameNode(n).id, "name-of", STRENGTH.nameOf, [gh.url]);
    }
    if (gh.blog) {
      const site = ensureSiteNode(gh.blog);
      if (site) addEdge(loginNode.id, site.id, "site-of", STRENGTH.siteOf, [gh.url]);
    }
  }

  // 5e. Twitter profile fields: display name (only when it looks like a real
  // name — handle echoes and taglines are not identity leaks) and website.
  for (const res of input.twitter?.results ?? []) {
    const p = res.profile;
    if (!p) continue;
    const node = handleNodes.get(normalizeHandleKey(p.screenName));
    if (!node) continue;
    const profileUrl = `https://x.com/${p.screenName}`;
    if (p.name && looksLikeRealName(p.name, p.screenName)) {
      addEdge(node.id, ensureNameNode(p.name).id, "name-of", STRENGTH.nameOf, [profileUrl]);
    }
    if (p.url) {
      const site = ensureSiteNode(p.url);
      if (site) addEdge(node.id, site.id, "site-of", STRENGTH.siteOf, [profileUrl]);
    }
  }

  // 5f. Email local-part heuristic: johndoe@gmail.com ↔ handle johndoe.
  // Weak (people reuse strings by accident) but far from noise — it is the
  // same reuse instinct that produces cross-platform handle clusters.
  for (const [lc] of emailNodes) {
    const localKey = normalizeHandleKey(lc.split("@")[0] ?? "");
    const handleNode = localKey ? handleNodes.get(localKey) : undefined;
    if (handleNode) {
      addEdge(handleNode.id, `email:${lc}`, "email-of", STRENGTH.emailLocalPart, [
        ...(emailProvenance.get(lc) ?? []).slice(0, 1),
      ]);
    }
  }

  /* ── 6. Assemble: deterministic ordering everywhere ──────────────────── */
  const nodes = [
    ...handleNodes.values(),
    ...emailNodes.values(),
    ...nameNodes.values(),
    ...siteNodes.values(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...edgeMap.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.kind.localeCompare(b.kind) || a.to.localeCompare(b.to),
  );

  /* ── 7. Person entities: connected components over merging edges ────── */
  const parent = new Map<string, string>(nodes.map((n) => [n.id, n.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of edges) {
    if (e.strength >= MERGE_MIN_STRENGTH && !NON_MERGING_KINDS.has(e.kind)) union(e.from, e.to);
  }
  const components = new Map<string, string[]>();
  for (const n of nodes) {
    const root = find(n.id);
    const members = components.get(root) ?? [];
    members.push(n.id);
    components.set(root, members);
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const persons: PersonEntity[] = [];
  for (const members of components.values()) {
    const sorted = [...members].sort();
    const memberSet = new Set(sorted);
    const internal = edges.filter((e) => memberSet.has(e.from) && memberSet.has(e.to));
    const eligible = internal.filter(
      (e) => e.strength >= MERGE_MIN_STRENGTH && !NON_MERGING_KINDS.has(e.kind),
    );
    const isSubject = memberSet.has(auditedId);
    // Singleton components are persons only when they are the subject or a
    // multi-platform handle (a namesake cluster); single-platform strays are
    // orphans, rendered as a count, not entities.
    const singleHandle = sorted.length === 1 && sorted[0].startsWith("handle:");
    const isPerson =
      isSubject ||
      internal.length > 0 ||
      sorted.length > 1 ||
      (singleHandle && (nodeById.get(sorted[0])?.platforms.length ?? 0) >= 2);
    if (!isPerson) continue;
    const hasBridgeOwner = internal.some(
      (e) => (e.kind === "rename" || e.kind === "anchor-rename") && memberSet.has(e.from),
    );
    const kinds = new Set(eligible.map((e) => e.kind));
    const confidence: PersonEntity["confidence"] =
      kinds.size >= 2 || hasBridgeOwner ? "high" : eligible.length >= 2 ? "medium" : "low";
    persons.push({
      id: `person:${sorted[0]}`,
      handleNodes: sorted.filter((id) => id.startsWith("handle:")),
      emailNodes: sorted.filter((id) => id.startsWith("email:")),
      nameNodes: sorted.filter((id) => id.startsWith("name:")),
      confidence,
      strongestEdge: internal.reduce((max, e) => Math.max(max, e.strength), 0),
      isSubject,
    });
  }
  persons.sort((a, b) => Number(b.isSubject) - Number(a.isSubject) || a.id.localeCompare(b.id));

  return { nodes, edges, persons };
}

/* ────────────────────────────────────────────────────────────────────────
 * Rendering
 * ──────────────────────────────────────────────────────────────────────── */

function shortValue(id: string, nodeById: Map<string, IdentityGraphNode>): string {
  return nodeById.get(id)?.value ?? id;
}

/** Handles that are the CURRENT end of a rename edge inside the person —
 * listed first because they are the subject's live identity. */
function currentIdentityFirst(person: PersonEntity, edges: IdentityGraphEdge[]): string[] {
  const renameSources = new Set(
    edges
      .filter((e) => (e.kind === "rename" || e.kind === "anchor-rename") && person.handleNodes.includes(e.from))
      .map((e) => e.from),
  );
  return [...person.handleNodes].sort(
    (a, b) => Number(renameSources.has(b)) - Number(renameSources.has(a)) || a.localeCompare(b),
  );
}

/**
 * Render the "## Identity Graph" report block: the subject person entity
 * (handles/emails/names + the fusion edges in compact `a ─kind(s)→ b`
 * notation), then namesake candidate persons, then a one-line count of
 * unconnected handles. Ground-truth framing throughout: fused
 * deterministically from the pass results; namesakes are explicitly NOT the
 * subject. Returns "" when the graph holds nothing beyond the audited
 * username (nothing to say).
 */
export function renderIdentityGraphBlock(graph: IdentityGraph, username: string): string {
  if (graph.nodes.length <= 1) return "";
  const subject = graph.persons.find((p) => p.isSubject);
  if (!subject) return "";
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const memberSet = new Set(subject.handleNodes.concat(subject.emailNodes, subject.nameNodes));
  const internalEdges = graph.edges.filter((e) => memberSet.has(e.from) && memberSet.has(e.to));

  const lines: string[] = [];
  lines.push("## Identity Graph");
  lines.push("");
  lines.push(
    `*Person-level fusion computed deterministically from the pass results (rename bridges, handle clusters and drift, corpus disclosures, GitHub/Twitter profile fields). Every identifier below carries its fusion evidence; separate persons are explicitly NOT u/${username}.*`,
  );
  lines.push("");
  lines.push(`### Subject person — u/${username} (confidence: ${subject.confidence})`);
  lines.push("");
  for (const id of currentIdentityFirst(subject, graph.edges)) {
    const n = nodeById.get(id);
    if (!n) continue;
    lines.push(`- Handle \`${n.value}\` — platforms: ${n.platforms.join(", ") || "unknown"}`);
  }
  for (const id of subject.emailNodes) lines.push(`- Email \`${nodeById.get(id)?.value ?? id}\``);
  for (const id of subject.nameNodes) lines.push(`- Name **${nodeById.get(id)?.value ?? id}**`);
  const sites = internalEdges
    .filter((e) => e.kind === "site-of" && memberSet.has(e.from))
    .map((e) => nodeById.get(e.to)?.value)
    .filter((v): v is string => Boolean(v));
  for (const s of [...new Set(sites)].sort()) lines.push(`- Site ${s}`);

  lines.push("");
  lines.push("Fusion edges:");
  for (const e of internalEdges) {
    lines.push(`- ${shortValue(e.from, nodeById)} ─${e.kind}(${e.strength.toFixed(1)})→ ${shortValue(e.to, nodeById)}`);
  }

  const namesakes = graph.persons.filter((p) => !p.isSubject);
  if (namesakes.length > 0) {
    lines.push("");
    lines.push("### Separate persons (namesake candidates) — NOT the subject");
    lines.push("");
    for (const p of namesakes) {
      const parts: string[] = [];
      for (const id of p.handleNodes) {
        const n = nodeById.get(id);
        if (n) parts.push(`\`${n.value}\` (${n.platforms.join(", ") || "unknown"})`);
      }
      for (const id of p.emailNodes) parts.push(`\`${nodeById.get(id)?.value ?? id}\``);
      for (const id of p.nameNodes) parts.push(`**${nodeById.get(id)?.value ?? id}**`);
      lines.push(
        `- ${parts.join(", ")} — nothing ties this ${p.confidence === "low" ? "string match" : "cluster"} to u/${username}; never attribute its activity to the subject.`,
      );
    }
  }

  const personNodeIds = new Set(graph.persons.flatMap((p) => [...p.handleNodes, ...p.emailNodes, ...p.nameNodes]));
  const orphans = graph.nodes.filter((n) => n.kind === "handle" && !personNodeIds.has(n.id)).length;
  if (orphans > 0) {
    lines.push("");
    lines.push(`Plus ${orphans} unconnected single-platform handle${orphans === 1 ? "" : "s"} (no fusion evidence).`);
  }
  return lines.join("\n");
}

/**
 * Compact prompt-injection form of the graph: subject handles (current
 * identity first), subject emails/names, and the namesake list with an
 * explicit instruction to never attribute namesake activity to the subject.
 * Returns "" when the graph holds nothing beyond the audited username — an
 * empty string injects nothing and wastes no prompt budget.
 */
export function renderIdentityGraphContextForPrompt(graph: IdentityGraph, username: string): string {
  if (graph.nodes.length <= 1) return "";
  const subject = graph.persons.find((p) => p.isSubject);
  if (!subject) return "";
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  const handles = currentIdentityFirst(subject, graph.edges).map((id) => {
    const n = nodeById.get(id);
    return n ? `${n.value} (${n.platforms.join("/") || "unknown"})` : id;
  });
  const emails = subject.emailNodes.map((id) => nodeById.get(id)?.value ?? id);
  const names = subject.nameNodes.map((id) => nodeById.get(id)?.value ?? id);
  const namesakes = graph.persons
    .filter((p) => !p.isSubject)
    .map((p) =>
      p.handleNodes
        .map((id) => {
          const n = nodeById.get(id);
          return n ? `${n.value} (${n.platforms.join("/") || "unknown"})` : id;
        })
        .join(", "),
    );

  const lines: string[] = [];
  lines.push("IDENTITY GRAPH (deterministic person fusion — ground truth):");
  lines.push(`- Subject handles, current identity first: ${handles.join("; ")}`);
  if (emails.length > 0) lines.push(`- Subject emails: ${emails.join("; ")}`);
  if (names.length > 0) lines.push(`- Subject names: ${names.join("; ")}`);
  if (namesakes.length > 0) {
    lines.push(
      `- Namesakes (NOT u/${username} — never attribute their activity, posts, or identifiers to the subject): ${namesakes.join("; ")}`,
    );
  }
  return lines.join("\n");
}
