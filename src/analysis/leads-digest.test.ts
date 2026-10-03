import { describe, expect, test } from "bun:test";
import { renderSubAgentLeadsDigest } from "./leads-digest.ts";
import type { WebSweepResult } from "./web-sweep.ts";
import type { GitHubIdentity, GitHubPassResult } from "./github-pass.ts";
import type { TwitterPassResult, TwitterSeedResult, TwitterUserProfile } from "./twitter-pass.ts";

/**
 * Leads-digest regression: the compact ground-truth digest for domain
 * sub-agents must (a) surface every lead category in priority order, (b) stay
 * "" when no pass produced anything, (c) stay under its hard char cap on fat
 * inputs, and (d) be byte-deterministic. Pure projection over pass-result
 * fixtures — no network, no LLM, no clocks.

 * Handle fixtures (fixtureveil/fixturenew) follow the repo convention of
 * canary examples in tests only.
 */

function makeProfile(screenName: string, name: string, url = ""): TwitterUserProfile {
  return {
    id: `id_${screenName}`,
    name,
    screenName,
    bio: "",
    location: "",
    url,
    followers: 10,
    following: 5,
    tweets: 20,
    likes: 1,
    verified: false,
    profileImageUrl: "",
    createdAt: "2020-01-01T00:00:00Z",
  };
}

function makeSweep(overrides: Partial<WebSweepResult> = {}): WebSweepResult {
  return {
    username: "fixtureveil",
    queries: [],
    searchResultCount: 0,
    candidates: [],
    identifiers: { emails: [], socialHandles: [] },
    ...overrides,
  };
}

function makeGitHub(identities: GitHubIdentity[]): GitHubPassResult {
  return { queried: [], identities, rateLimited: false };
}

function makeTwitter(results: TwitterSeedResult[]): TwitterPassResult {
  return {
    seeds: [],
    results,
    identifiers: { emails: [], socialHandles: [] },
    identifierSources: { emails: {}, handles: {} },
    rateLimited: false,
  };
}

describe("renderSubAgentLeadsDigest", () => {
  test("renders bridge owners first with tier/platforms/URL, plus emails, GitHub leaks, Twitter alts", () => {
    const sweep = makeSweep({
      identifiers: {
        emails: ["fixturemail@example.com"],
        socialHandles: [
          { platform: "github", handle: "fixturenew", url: "https://github.com/fixturenew" },
          { platform: "gitlab", handle: "clusterhandle", url: "https://gitlab.com/clusterhandle" },
          { platform: "x", handle: "clusterhandle", url: "https://x.com/clusterhandle" },
        ],
      },
      identifierSources: {
        emails: { "fixturemail@example.com": ["https://a.example", "https://b.example"] },
        handles: {},
        freemail: {},
      },
      bridgeEvidence: {
        fixturenew: [{ url: "https://github.com/fixturenew", snippet: "aka fixtureveil", target: "fixtureveil" }],
      },
    });
    const gh = makeGitHub([
      {
        login: "fixturenew",
        url: "https://github.com/fixturenew",
        name: "Fixture Name",
        company: "Fixture Corp",
        location: "Lisbon",
        blog: "https://fixture.example",
        email: "fixture@fixture.example",
        twitterUsername: "fixturenew",
        commitAuthors: [
          { name: "Fixture Name", email: "fixture@users.noreply.github.com", repo: "fixture-repo", date: "2023-01-01T00:00:00Z", attributedLogin: "fixturenew" },
        ],
        commitStats: { scanned: 1, attributed: 1, excluded: 0 },
      },
    ]);
    const tw = makeTwitter([
      {
        seed: "fixturenew",
        profile: makeProfile("fixturenew", "Fixture Name", "https://fixture.example"),
        followingScanned: 10,
        altCandidates: [
          { profile: makeProfile("fixture_alt", "Fixture Alt", "https://alt.example"), score: 3, reasons: ["username scheme"] },
        ],
      },
    ]);

    const out = renderSubAgentLeadsDigest({ username: "fixtureveil", webSweep: sweep, gitHub: gh, twitter: tw });

    expect(out).toContain("=== DETERMINISTIC LEADS (verified by pre-analysis passes — ground truth) ===");
    expect(out.indexOf("BRIDGE OWNERS")).toBeLessThan(out.indexOf("CROSS-PLATFORM CLUSTERS"));
    expect(out.indexOf("CROSS-PLATFORM CLUSTERS")).toBeLessThan(out.indexOf("EMAILS"));
    expect(out.indexOf("EMAILS")).toBeLessThan(out.indexOf("GITHUB IDENTITIES WITH LEAKS"));
    expect(out.indexOf("GITHUB IDENTITIES WITH LEAKS")).toBeLessThan(out.indexOf("TWITTER PROFILE"));
    expect(out).toContain("=== END DETERMINISTIC LEADS ===");

    // Bridge owner: handle, tier, platforms, one URL, current-identity framing.
    expect(out).toContain("- fixturenew [tier: bridge; github]");
    expect(out).toContain("https://github.com/fixturenew");
    expect(out).toContain("CURRENT identity");

    // Cluster: handle + platforms.
    expect(out).toContain("- clusterhandle — gitlab, x");

    // Email with seen-on URL count.
    expect(out).toContain("fixturemail@example.com — 2 URL(s)");

    // GitHub leak fields + commit identity.
    expect(out).toContain('name "Fixture Name"');
    expect(out).toContain("company Fixture Corp");
    expect(out).toContain("location Lisbon");
    expect(out).toContain("email fixture@fixture.example");
    expect(out).toContain("twitter @fixturenew");
    expect(out).toContain('commit author: "Fixture Name <fixture@users.noreply.github.com>" (fixture-repo)');

    // Twitter profile + alt candidate.
    expect(out).toContain('TWITTER PROFILE: @fixturenew — "Fixture Name", website https://fixture.example');
    expect(out).toContain('ALT-ACCOUNT CANDIDATE: @fixture_alt — "Fixture Alt", website https://alt.example');
  });

  test("empty input (no passes) renders empty string", () => {
    expect(renderSubAgentLeadsDigest({ username: "fixtureveil" })).toBe("");
    // Passes present but empty of leads also render nothing.
    expect(
      renderSubAgentLeadsDigest({
        username: "fixtureveil",
        webSweep: makeSweep(),
        gitHub: makeGitHub([]),
        twitter: makeTwitter([]),
      }),
    ).toBe("");
  });

  test("fat fixture stays under the 2500-char cap", () => {
    const socialHandles = [
      { platform: "github", handle: "bridgeone", url: "https://github.com/bridgeone" },
      { platform: "x", handle: "bridgetwo", url: "https://x.com/bridgetwo" },
      { platform: "gitlab", handle: "bridgethree", url: "https://gitlab.com/bridgethree" },
      { platform: "youtube", handle: "bridgefour", url: "https://youtube.com/@bridgefour" },
      { platform: "gitlab", handle: "clustera", url: "https://gitlab.com/clustera" },
      { platform: "x", handle: "clustera", url: "https://x.com/clustera" },
      { platform: "instagram", handle: "clusterb", url: "https://instagram.com/clusterb" },
      { platform: "youtube", handle: "clusterb", url: "https://youtube.com/@clusterb" },
    ];
    const sweep = makeSweep({
      identifiers: {
        emails: ["e1@example.com", "e2@example.com", "e3@example.com", "e4@example.com", "e5@example.com", "e6@example.com"],
        socialHandles,
      },
      identifierSources: {
        emails: Object.fromEntries(
          ["e1@example.com", "e2@example.com", "e3@example.com", "e4@example.com", "e5@example.com", "e6@example.com"].map((e, i) => [
            e,
            Array.from({ length: i + 1 }, (_, j) => `https://src${j}.example`),
          ]),
        ),
        handles: {},
        freemail: {},
      },
      bridgeEvidence: {
        bridgeone: [{ url: "https://github.com/bridgeone", snippet: "aka fixtureveil", target: "fixtureveil" }],
        bridgetwo: [{ url: "https://x.com/bridgetwo", snippet: "old: fixtureveil", target: "fixtureveil" }],
        bridgethree: [{ url: "https://gitlab.com/bridgethree", snippet: "fixtureveil was here", target: "fixtureveil" }],
        bridgefour: [{ url: "https://youtube.com/@bridgefour", snippet: "renamed from fixtureveil", target: "fixtureveil" }],
      },
    });
    const gh = makeGitHub(
      ["ghone", "ghtwo", "ghthree"].map((login) => ({
        login,
        url: `https://github.com/${login}`,
        name: `Person ${login}`,
        company: `${login} Industries`,
        location: "Somewhere",
        blog: `https://${login}.example`,
        email: `${login}@example.com`,
        twitterUsername: login,
        commitAuthors: [
          { name: `Person ${login}`, email: `${login}@users.noreply.github.com`, repo: `${login}-repo`, date: "2023-01-01T00:00:00Z", attributedLogin: login },
          { name: `Person ${login} 2`, email: `${login}2@users.noreply.github.com`, repo: `${login}-repo2`, date: "2023-02-01T00:00:00Z", attributedLogin: login },
          { name: `Person ${login} 3`, email: `${login}3@users.noreply.github.com`, repo: `${login}-repo3`, date: "2023-03-01T00:00:00Z", attributedLogin: login },
        ],
        commitStats: { scanned: 3, attributed: 3, excluded: 0 },
      })),
    );
    const tw = makeTwitter(
      ["twone", "twtwo", "twthree"].map((seed) => ({
        seed,
        profile: makeProfile(seed, `Display ${seed}`, `https://${seed}.example`),
        followingScanned: 50,
        altCandidates: [{ profile: makeProfile(`${seed}_alt`, `Alt ${seed}`, `https://${seed}alt.example`), score: 2, reasons: ["name match"] }],
      })),
    );

    const out = renderSubAgentLeadsDigest({ username: "fixtureveil", webSweep: sweep, gitHub: gh, twitter: tw });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(2500);
    // Per-section truncation: at most 4 bridge owners / clusters / emails, 3 GitHub, 3 Twitter.
    expect(out.match(/^TWITTER PROFILE:/gm)?.length).toBe(3);
  });

  test("deterministic: same input renders the identical string", () => {
    const sweep = makeSweep({
      identifiers: {
        emails: ["det@example.com"],
        socialHandles: [
          { platform: "github", handle: "detbridge", url: "https://github.com/detbridge" },
        ],
      },
      bridgeEvidence: {
        detbridge: [{ url: "https://github.com/detbridge", snippet: "fixtureveil", target: "fixtureveil" }],
      },
    });
    const a = renderSubAgentLeadsDigest({ username: "fixtureveil", webSweep: sweep });
    const b = renderSubAgentLeadsDigest({ username: "fixtureveil", webSweep: makeSweep({
      identifiers: { emails: ["det@example.com"], socialHandles: [{ platform: "github", handle: "detbridge", url: "https://github.com/detbridge" }] },
      bridgeEvidence: { detbridge: [{ url: "https://github.com/detbridge", snippet: "fixtureveil", target: "fixtureveil" }] },
    }) });
    expect(a).toBe(b);
    expect(a).toContain("detbridge");
  });
});
