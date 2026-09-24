/**
 * Golden eval fixtures — versioned, network-free, deterministic.
 *
 * Each fixture provides raw inputs + ground truth for one edge-case category.
 * The runner injects them via WebSweepDeps + GitHub pass fakes so the full
 * deterministic attribution pipeline (sweep → github-pass → corroboration)
 * can be scored without any network calls.
 *
 * Version: 1
 */

import type { EvalFixture } from "./schema.ts";

// ── Helpers for building compact fixtures ────────────────────────────────

function ghUser(login: string, overrides: Record<string, any> = {}) {
  return { login, url: `https://github.com/${login}`, commitAuthors: [], commitStats: { scanned: 0, attributed: 0, excluded: 0 }, ...overrides };
}

function ghCommit(name: string, email: string, login: string, date = "2023-06-15T00:00:00Z") {
  return { commit: { author: { name, email, date } }, author: { login } };
}

function searchHit(query: string, title: string, url: string, description: string, markdown?: string): any {
  return { query, title, url, description, markdown };
}

function scrapePage(url: string, markdown: string, links: string[] = []): any {
  return { url, title: url, description: "", markdown, links };
}

// ── Fixture registry ─────────────────────────────────────────────────────

const FIXTURES: EvalFixture[] = [
  /* ═══════════════════════════════════════════════════════════════════════
   * 1. CONFIRMED STALE-REFERENCE BRIDGE
   *    github.com/fixturenew links back to fixtureveil via badge → bridge edge.
   * ═══════════════════════════════════════════════════════════════════════ */
  {
    id: "bridge-1",
    description: "A page owned by fixturenew on GitHub mentions the audited username fixtureveil in a profile badge. This is the canonical stale cross-reference: renamed handle, old badge still pointing back.",
    version: 1,
    categories: ["bridge", "renamed-handle"],
    inputs: {
      username: "fixtureveil",
      searchResults: {
        '"fixtureveil" github': [
          searchHit('"fixtureveil" github', "fixturenew", "https://github.com/fixturenew",
            "fixturenew — Security researcher. Previously known as fixtureveil. Badge: fixtureveil"),
        ],
      },
      scrapedPages: {
        "https://github.com/fixturenew": scrapePage("https://github.com/fixturenew",
          "## fixturenew\nSecurity researcher. Previously known as fixtureveil.\n**Achievements**: Arctic Code Vault Contributor\nemail: fixturenew@fixture.test"),
      },
      githubProfiles: {
        "fixturenew": ghUser("fixturenew", {
          name: "fixturenew", email: "fixturenew@fixture.test",
          location: "Hyderabad, India", blog: "https://fixturenew.example",
        }),
        "fixtureveil": ghUser("fixtureveil"),
      },
      githubCommits: {},
    },
    groundTruth: {
      identifiers: {
        emails: ["fixturenew@fixture.test"],
        handles: [{ platform: "github", handle: "fixturenew" }],
      },
      bridgeEdges: [
        { owner: "fixturenew", mentions: "fixtureveil", url: "https://github.com/fixturenew" },
      ],
      nonIdentifiers: { emails: [], handles: [] },
      subjectName: "fixturenew",
      subjectGitHubLogins: ["fixturenew"],
      expectedRisk: "high",
    },
  },

  /* ═══════════════════════════════════════════════════════════════════════
   * 2. UNRELATED MATCHING USERNAME
   *    A GitHub account with the same username as the audited Reddit account
   *    but completely different real identity. Must NOT be attributed.
   * ═══════════════════════════════════════════════════════════════════════ */
  {
    id: "unrelated-1",
    description: "Same username on GitHub but the profile shows a different person (different country, different bio). The deterministic layers must not attribute this account to the Reddit subject.",
    version: 1,
    categories: ["unrelated-handle", "common-username"],
    inputs: {
      username: "jhacker",
      searchResults: {
        '"jhacker" github': [
          searchHit('"jhacker" github', "jhacker", "https://github.com/jhacker",
            "jhacker — iOS developer in Tokyo. Coffee addict."),
        ],
      },
      scrapedPages: {
        "https://github.com/jhacker": scrapePage("https://github.com/jhacker",
          "## jhacker\niOS developer at LINE Corp. Lives in Tokyo. Coffee addict.\nEmail: jhacker@linecorp.com"),
      },
      githubProfiles: {
        "jhacker": ghUser("jhacker", {
          name: "James Hacker", email: "jhacker@linecorp.com",
          location: "Tokyo, Japan", company: "LINE Corp",
        }),
      },
      githubCommits: { "jhacker/coffee-app": [ghCommit("James Hacker", "jhacker@linecorp.com", "jhacker")] },
    },
    groundTruth: {
      identifiers: { emails: [], handles: [] },
      bridgeEdges: [],
      nonIdentifiers: {
        emails: ["jhacker@linecorp.com"],
        handles: [{ platform: "github", handle: "jhacker" }],
      },
      noResolvableIdentity: true,
      expectedRisk: "low",
    },
  },

  /* ═══════════════════════════════════════════════════════════════════════
   * 3. COMMON USERNAME — "john" on Reddit, many GitHub accounts.
   * ═══════════════════════════════════════════════════════════════════════ */
  {
    id: "common-username-1",
    description: "Extremely common username — search returns many profiles with no bridge or cluster signal. The system must produce zero identifiers, not a random pick.",
    version: 1,
    categories: ["common-username"],
    inputs: {
      username: "john",
      searchResults: {
        '"john" github': [
          searchHit('"john" github', "john", "https://github.com/john", "john — Software engineer"),
          searchHit('"john" github', "john1", "https://github.com/john1", "john1 — Designer"),
          searchHit('"john" github', "john-dev", "https://github.com/john-dev", "john-dev — Full-stack"),
        ],
      },
      scrapedPages: {
        "https://github.com/john": scrapePage("https://github.com/john", "## john\nSoftware engineer. No personal info.\n"),
        "https://github.com/john1": scrapePage("https://github.com/john1", "## john1\nDesigner. No personal info.\n"),
        "https://github.com/john-dev": scrapePage("https://github.com/john-dev", "## john-dev\nFull-stack dev. No personal info.\n"),
      },
      githubProfiles: { "john": ghUser("john"), "john1": ghUser("john1"), "john-dev": ghUser("john-dev") },
      githubCommits: {},
    },
    groundTruth: {
      identifiers: { emails: [], handles: [] },
      bridgeEdges: [],
      nonIdentifiers: {
        emails: [],
        handles: [
          { platform: "github", handle: "john" },
          { platform: "github", handle: "john1" },
          { platform: "github", handle: "john-dev" },
        ],
      },
      noResolvableIdentity: true,
      expectedRisk: "low",
    },
  },

  /* ═══════════════════════════════════════════════════════════════════════
   * 4. COLLABORATOR GITHUB COMMITS
   *    Only owner-verified commits feed identity. Collaborator identities
   *    must NEVER leak into the subject's identity row.
   * ═══════════════════════════════════════════════════════════════════════ */
  {
    id: "collaborator-commit-1",
    description: "GitHub repo with owner commits + two collaborators + a bot. After the fix, only owner-verified commits feed identity.",
    version: 1,
    categories: ["collaborator-commit"],
    inputs: {
      username: "alice-dev",
      searchResults: {
        '"alice-dev" github': [
          searchHit('"alice-dev" github', "alice-dev", "https://github.com/alice-dev", "Alice — backend engineer"),
        ],
      },
      scrapedPages: {
        "https://github.com/alice-dev": scrapePage("https://github.com/alice-dev",
          "## Alice\nBackend engineer. Python & Rust.\nemail: alice@personal.dev"),
      },
      githubProfiles: {
        "alice-dev": ghUser("alice-dev", { name: "Alice Chen", email: "alice@personal.dev", location: "San Francisco" }),
      },
      githubCommits: {
        "alice-dev/backend": [
          ghCommit("Alice Chen", "alice@personal.dev", "alice-dev"),           // owner ✓
          ghCommit("Bob Marley", "bob@bigco.com", "bob-marley"),                // collaborator ✗
          ghCommit("Alice Chen", "alice@company.com", "alice-dev"),             // owner ✓
          ghCommit("Carol Singer", "carol@startup.io", "carol"),                // collaborator ✗
          ghCommit("dependabot[bot]", "support@github.com", "dependabot"),      // bot ✗
        ],
      },
    },
    groundTruth: {
      identifiers: {
        emails: ["alice@personal.dev", "alice@company.com"],
        handles: [{ platform: "github", handle: "alice-dev" }],
      },
      bridgeEdges: [],
      nonIdentifiers: {
        emails: ["bob@bigco.com", "carol@startup.io"],
        handles: [],
      },
      subjectName: "Alice Chen",
      subjectGitHubLogins: ["alice-dev"],
      expectedRisk: "medium",
    },
  },

  /* ═══════════════════════════════════════════════════════════════════════
   * 5. VENDOR AND NOREPLY EMAILS
   *    Scraped pages carry abuse@, info@, support@ — SITE addresses, not the
   *    subject's. Must never become identifiers or snowball seeds.
   * ═══════════════════════════════════════════════════════════════════════ */
  {
    id: "vendor-email-1",
    description: "A scraped personal site footer carries info@vendor.com and abuse@vendor.com. The site ALSO carries the real contact email. Only the real one should be extracted.",
    version: 1,
    categories: ["vendor-email"],
    inputs: {
      username: "dev_ninja",
      searchResults: {
        '"dev_ninja" portfolio': [
          searchHit('"dev_ninja" portfolio', "dev_ninja", "https://devninja.dev", "Portfolio — dev_ninja"),
        ],
      },
      scrapedPages: {
        "https://devninja.dev": scrapePage("https://devninja.dev",
          "# dev_ninja\nSecurity researcher.\nContact: devninja@proton.me\n\n---\nFooter: info@vendor.com | abuse@vendor.com | support@vendor.com"),
      },
      githubProfiles: {},
      githubCommits: {},
    },
    groundTruth: {
      identifiers: {
        emails: ["devninja@proton.me"],
        handles: [],
      },
      bridgeEdges: [],
      nonIdentifiers: {
        emails: ["info@vendor.com", "abuse@vendor.com", "support@vendor.com"],
        handles: [],
      },
      expectedRisk: "low",
    },
  },

  /* ═══════════════════════════════════════════════════════════════════════
   * 6. DISTRACTOR SEARCH RESULTS
   *    Search snippets carry unrelated emails. After the scoping fix, they
   *    must never become identifiers — only actually-scraped pages feed
   *    extraction.
   * ═══════════════════════════════════════════════════════════════════════ */
  {
    id: "distractor-1",
    description: "A search snippet mentions a distractor email. The page that triggered the snippet exists but was NOT scraped (only indexed). The distractor email must not appear in the extracted identifiers.",
    version: 1,
    categories: ["distractor"],
    inputs: {
      username: "researcher42",
      searchResults: {
        '"researcher42" github': [
          searchHit('"researcher42" github', "search-result-page", "https://github.com/search?q=researcher42",
            "Search results for researcher42 — found: researcher42@gmail.com in comment by some_random_user"),
          searchHit('"researcher42" github', "researcher42", "https://github.com/researcher42",
            "researcher42 — Security researcher"),
        ],
      },
      scrapedPages: {
        "https://github.com/researcher42": scrapePage("https://github.com/researcher42",
          "## researcher42\nSecurity researcher.\n"),
      },
      githubProfiles: { "researcher42": ghUser("researcher42") },
      githubCommits: {},
    },
    groundTruth: {
      identifiers: {
        emails: [],
        handles: [{ platform: "github", handle: "researcher42" }],
      },
      bridgeEdges: [],
      nonIdentifiers: { emails: ["researcher42@gmail.com"], handles: [] },
      expectedRisk: "low",
    },
  },

  /* ═══════════════════════════════════════════════════════════════════════
   * 7. RENAMED HANDLE — cross-platform persistence
   *    Subject moved from "old_dev" to "new_dev". Old handle still appears
   *    on a forgotten profile page linking to the new account.
   * ═══════════════════════════════════════════════════════════════════════ */
  {
    id: "renamed-1",
    description: "The subject renamed from old_dev to new_dev. GitHub profile has a stale bio mentioning old_dev. Bridge edge should be detected.",
    version: 1,
    categories: ["renamed-handle", "bridge"],
    inputs: {
      username: "old_dev",
      searchResults: {
        '"old_dev" github': [
          searchHit('"old_dev" github', "new_dev", "https://github.com/new_dev",
            "new_dev — Previously old_dev. Open source contributor."),
        ],
        '"new_dev" github': [
          searchHit('"new_dev" github', "new_dev", "https://github.com/new_dev",
            "new_dev — Open source contributor"),
        ],
        '"new_dev" portfolio OR about OR contact OR email': [
          searchHit('"new_dev" portfolio', "new_dev", "https://newdev.io",
            "new_dev — developer portfolio"),
        ],
      },
      scrapedPages: {
        "https://github.com/new_dev": scrapePage("https://github.com/new_dev",
          "## new_dev\nFormerly known as old_dev.\nEmail: newdev@personal.io\nTwitter: @new_dev"),
        "https://newdev.io": scrapePage("https://newdev.io",
          "# new_dev\nContact: newdev@personal.io\nGitHub: github.com/new_dev\nTwitter: @new_dev"),
      },
      githubProfiles: {
        "new_dev": ghUser("new_dev", {
          name: "New Developer", email: "newdev@personal.io", twitterUsername: "new_dev",
        }),
      },
      githubCommits: {},
    },
    groundTruth: {
      identifiers: {
        emails: ["newdev@personal.io"],
        handles: [
          { platform: "github", handle: "new_dev" },
          { platform: "x", handle: "new_dev" },
        ],
      },
      bridgeEdges: [
        { owner: "new_dev", mentions: "old_dev", url: "https://github.com/new_dev" },
      ],
      nonIdentifiers: { emails: [], handles: [] },
      subjectName: "New Developer",
      subjectGitHubLogins: ["new_dev"],
      expectedRisk: "high",
    },
  },

  /* ═══════════════════════════════════════════════════════════════════════
   * 8. CONFLICTING NAMES AND LOCATIONS
   *    The system finds two plausible names and two disconnected cities.
   *    Corroboration should flag contradictions and NOT pick one at random.
   * ═══════════════════════════════════════════════════════════════════════ */
  {
    id: "conflicting-1",
    description: "Two different names and two disconnected locations surface. The system must flag contradictions in both dimensions rather than silently choosing.",
    version: 1,
    categories: ["conflicting-signal"],
    inputs: {
      username: "mystery_user",
      redditHistory: [
        { body: "I live in Mumbai, been here for years", title: "", permalink: "/r/mumbai/comments/a1/title/", subreddit: "mumbai", created_utc: 1700000000 },
        { body: "Just moved to Berlin last month!", title: "Moving", permalink: "/r/berlin/comments/b2/title/", subreddit: "berlin", created_utc: 1710000000 },
        { body: "My name is Raj, nice to meet you all", title: "", permalink: "/r/india/comments/c3/title/", subreddit: "india", created_utc: 1705000000 },
        { body: "Call me Alex, that's what my friends use", title: "", permalink: "/r/casual/comments/d4/title/", subreddit: "casual", created_utc: 1712000000 },
      ],
      searchResults: {},
      scrapedPages: {},
      githubProfiles: {},
      githubCommits: {},
      findings: [
        { category: "location", claim: "lives in Mumbai", confidence: "medium", evidence: [{ quote: "I live in Mumbai", permalink: "/r/mumbai/comments/a1/title/" }] },
        { category: "location", claim: "moved to Berlin", confidence: "medium", evidence: [{ quote: "Just moved to Berlin", permalink: "/r/berlin/comments/b2/title/" }] },
        { category: "real_name", claim: "name is Raj", confidence: "medium", evidence: [{ quote: "My name is Raj", permalink: "/r/india/comments/c3/title/" }] },
        { category: "real_name", claim: "goes by Alex", confidence: "medium", evidence: [{ quote: "Call me Alex", permalink: "/r/casual/comments/d4/title/" }] },
      ],
    },
    groundTruth: {
      identifiers: { emails: [], handles: [] },
      bridgeEdges: [],
      nonIdentifiers: { emails: [], handles: [] },
      subjectLocation: "Unknown",
      expectContradiction: true,
      expectedRisk: "medium",
    },
  },

  /* ═══════════════════════════════════════════════════════════════════════
   * 9. NO RESOLVABLE IDENTITY
   *    Account with only generic comments. System should produce zero
   *    identifiers and low confidence, not invent a person.
   * ═══════════════════════════════════════════════════════════════════════ */
  {
    id: "no-identity-1",
    description: "Account with nothing but generic comments — no names, locations, handles, or emails. System must produce zero identifiers and low risk.",
    version: 1,
    categories: ["no-identity"],
    inputs: {
      username: "anon_reader",
      redditHistory: [
        { body: "This is interesting, thanks for sharing.", title: "", permalink: "/r/tech/comments/e1/title/", subreddit: "tech", created_utc: 1700000000 },
        { body: "I agree with this take.", title: "", permalink: "/r/politics/comments/f2/title/", subreddit: "politics", created_utc: 1705000000 },
        { body: "Upvoted for visibility.", title: "", permalink: "/r/news/comments/g3/title/", subreddit: "news", created_utc: 1710000000 },
      ],
      searchResults: {
        '"anon_reader" github': [
          searchHit('"anon_reader" github', "anon_reader", "https://github.com/anon_reader", "anon_reader — "),
        ],
      },
      scrapedPages: {
        "https://github.com/anon_reader": scrapePage("https://github.com/anon_reader",
          "## anon_reader\nNo public profile information.\n"),
      },
      githubProfiles: { "anon_reader": ghUser("anon_reader") },
      githubCommits: {},
    },
    groundTruth: {
      identifiers: { emails: [], handles: [] },
      bridgeEdges: [],
      nonIdentifiers: { emails: [], handles: [] },
      noResolvableIdentity: true,
      expectedRisk: "low",
    },
  },

  /* ═══════════════════════════════════════════════════════════════════════
   * 10. PARTIAL ARCHIVE COVERAGE
   *     Only a small subset of the user's history is available. The
   *     system must still run and produce whatever it can, not crash
   *     or produce spurious high-confidence results from thin data.
   * ═══════════════════════════════════════════════════════════════════════ */
  {
    id: "partial-1",
    description: "Only 2 items available (tiny account). The system must still function, produce whatever limited results the data supports, and not inflate confidence.",
    version: 1,
    categories: ["partial-archive"],
    inputs: {
      username: "tiny_user",
      redditHistory: [
        { body: "I'm a CS student at UT Austin. Email me at tiny@utexas.edu for project collab.", title: "Looking for project partners", permalink: "/r/utaustin/comments/h1/title/", subreddit: "utaustin", created_utc: 1700000000 },
        { body: "My GitHub is github.com/tiny-dev", title: "", permalink: "/r/programming/comments/i2/title/", subreddit: "programming", created_utc: 1705000000 },
      ],
      searchResults: {},
      scrapedPages: {},
      githubProfiles: {
        "tiny-dev": ghUser("tiny-dev", { name: "Tiny Dev", email: "tiny@utexas.edu" }),
      },
      githubCommits: {},
    },
    groundTruth: {
      identifiers: {
        emails: ["tiny@utexas.edu"],
        handles: [{ platform: "github", handle: "tiny-dev" }],
      },
      bridgeEdges: [],
      nonIdentifiers: { emails: [], handles: [] },
      subjectName: "Tiny Dev",
      subjectGitHubLogins: ["tiny-dev"],
      expectedRisk: "medium",
    },
  },

  /* ═══════════════════════════════════════════════════════════════════════
   * 11. DELETED-CONTENT EDGE CASES
   *     Several posts are deleted but their titles/permalinks survive.
   *     Extractor must still find identifiers in the surviving items,
   *     and deleted-body placeholders must not false-trigger.
   * ═══════════════════════════════════════════════════════════════════════ */
  {
    id: "deleted-1",
    description: "Account with several deleted items. Identifiers in surviving items must be found. [deleted] body placeholders must not produce synthetic identifiers.",
    version: 1,
    categories: ["deleted-content"],
    inputs: {
      username: "ghost_user",
      redditHistory: [
        { body: "[deleted]", title: "", permalink: "/r/askreddit/comments/j1/title/", subreddit: "askreddit", created_utc: 1690000000, is_deleted: true },
        { body: "My real email is ghost@shadow.dev", title: "Contact info", permalink: "/r/forhire/comments/k2/title/", subreddit: "forhire", created_utc: 1700000000 },
        { body: "[removed]", title: "", permalink: "/r/politics/comments/l3/title/", subreddit: "politics", created_utc: 1710000000, is_removed: true },
        { body: "I work at a stealth-mode cybersecurity startup in Bangalore", title: "", permalink: "/r/bangalore/comments/m4/title/", subreddit: "bangalore", created_utc: 1715000000 },
      ],
      searchResults: {},
      scrapedPages: {},
      githubProfiles: {},
      githubCommits: {},
    },
    groundTruth: {
      identifiers: {
        emails: ["ghost@shadow.dev"],
        handles: [],
      },
      bridgeEdges: [],
      nonIdentifiers: { emails: [], handles: [] },
      expectedRisk: "low",
    },
  },
];

export { FIXTURES };
