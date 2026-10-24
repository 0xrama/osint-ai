/**
 * Unit tests for the person-level identity graph — pure fixtures over the
 * exported pass result types (no network, no LLM). Each test pins one edge
 * semantics or one fusion rule; canary handles (fixtureveil → fixturenew)
 * live here and in comments only, never in code paths.
 */

import { describe, expect, test } from "bun:test";
import {
  buildIdentityGraph,
  renderIdentityGraphBlock,
  renderIdentityGraphContextForPrompt,
  type IdentityGraphInput,
} from "./identity-graph.ts";
import type { WebSweepResult } from "./web-sweep.ts";
import type { GitHubPassResult } from "./github-pass.ts";

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

function makeGitHub(overrides: Partial<GitHubPassResult> = {}): GitHubPassResult {
  return {
    queried: [],
    identities: [],
    rateLimited: false,
    ...overrides,
  };
}

function edgeBetween(graph: ReturnType<typeof buildIdentityGraph>, a: string, b: string) {
  return graph.edges.find(
    (e) => (e.from === a && e.to === b) || (e.from === b && e.to === a),
  );
}

describe("identity graph: subject fusion", () => {
  test("bridge owner + audited username + GitHub email/name fuse into ONE high-confidence subject person", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        identifiers: {
          emails: [],
          socialHandles: [
            { platform: "github", handle: "fixturenew", url: "https://github.com/fixturenew" },
            { platform: "x", handle: "fixturenew", url: "https://x.com/fixturenew" },
          ],
        },
        bridgeEvidence: {
          fixturenew: [
            { url: "https://github.com/fixturenew", snippet: "…formerly fixtureveil…", target: "fixtureveil" },
          ],
        },
      }),
      gitHub: makeGitHub({
        queried: ["fixturenew"],
        identities: [
          {
            login: "fixturenew",
            url: "https://github.com/fixturenew",
            name: "John Doe",
            email: "john@example.com",
            commitAuthors: [
              { name: "John Doe", email: "john@example.com", repo: "fixturenew/dev", attributedLogin: "fixturenew" },
            ],
            commitStats: { scanned: 10, attributed: 10, excluded: 0 },
          },
        ],
      }),
    });

    const subject = graph.persons.find((p) => p.isSubject);
    expect(subject).toBeDefined();
    expect(subject!.confidence).toBe("high");
    expect(subject!.handleNodes).toContain("handle:fixtureveil");
    expect(subject!.handleNodes).toContain("handle:fixturenew");
    expect(subject!.emailNodes).toContain("email:john@example.com");
    expect(subject!.nameNodes).toContain("name:john doe");

    // One fused person: every other person (if any) shares no nodes with it.
    const renames = graph.edges.filter((e) => e.kind === "rename");
    expect(renames.length).toBe(1);
    expect(renames[0].from).toBe("handle:fixturenew");
    expect(renames[0].to).toBe("handle:fixtureveil");
    expect(renames[0].strength).toBe(0.7);
    expect(graph.edges.some((e) => e.kind === "email-of" && e.strength === 0.9)).toBe(true);
    expect(graph.edges.some((e) => e.kind === "name-of")).toBe(true);
  });

  test("anchor-rename bridge edge carries its kind and strength 1.0", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        // The sweep keys anchor entries by their link target, not the page owner.
        bridgeEvidence: {
          fixturenew: [
            {
              url: "https://dirpage.example/",
              snippet: "[fixtureveil](https://x.com/fixturenew)",
              target: "fixtureveil",
              kind: "anchor-rename",
              anchorTarget: "fixturenew",
            },
          ],
        },
      }),
    });

    const anchor = graph.edges.find((e) => e.kind === "anchor-rename");
    expect(anchor).toBeDefined();
    expect(anchor!.from).toBe("handle:fixturenew");
    expect(anchor!.to).toBe("handle:fixtureveil");
    expect(anchor!.strength).toBe(1.0);
    // The page owner only links the subject; it is not fused.
    expect(graph.persons.find((p) => p.isSubject)!.handleNodes).not.toContain("handle:dirpage");
  });
});

describe("identity graph: namesakes", () => {
  test("a same-string 2-platform handle with zero connecting evidence forms its OWN non-subject person", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        identifiers: {
          emails: [],
          socialHandles: [
            { platform: "github", handle: "fixturefan", url: "https://github.com/fixturefan" },
            { platform: "instagram", handle: "fixturefan", url: "https://instagram.com/fixturefan" },
          ],
        },
      }),
    });

    const namesake = graph.persons.find((p) => !p.isSubject && p.handleNodes.includes("handle:fixturefan"));
    expect(namesake).toBeDefined();
    expect(namesake!.isSubject).toBe(false);

    const subject = graph.persons.find((p) => p.isSubject)!;
    expect(subject.handleNodes).not.toContain("handle:fixturefan");

    const block = renderIdentityGraphBlock(graph, "fixtureveil");
    expect(block).toContain("namesake");
    expect(block).toContain("fixturefan");
    const promptCtx = renderIdentityGraphContextForPrompt(graph, "fixtureveil");
    expect(promptCtx).toContain("NOT u/fixtureveil");
  });
});

describe("identity graph: same-string profile namesakes", () => {
  // GitHub account whose login IS the audited username, located in Tokyo.
  const sameLogin = (extra: Partial<IdentityGraphInput>, posts: string[]) =>
    buildIdentityGraph({
      username: "fixtureveil",
      gitHub: makeGitHub({
        identities: [{
          login: "fixtureveil", url: "https://github.com/fixtureveil", email: "fixtureveil@corp.test",
          location: "Tokyo, Japan", commitAuthors: [], commitStats: { scanned: 0, attributed: 0, excluded: 0 },
        }],
      }),
      corpusTexts: posts.map((text, i) => ({ text, permalink: `/r/a/comments/${i}/` })),
      ...extra,
    });
  const subjectEmails = (g: ReturnType<typeof buildIdentityGraph>) => g.persons.find((p) => p.isSubject)!.emailNodes;

  test("username-only match contradicted by the corpus splits into a separate person", () => {
    const graph = sameLogin({}, ["I live in Manchester these days"]);
    expect(subjectEmails(graph)).not.toContain("email:fixtureveil@corp.test");
    const namesake = graph.persons.find((p) => !p.isSubject && p.emailNodes.includes("email:fixtureveil@corp.test"));
    expect(namesake?.handleNodes).toEqual(["handle:fixtureveil@github"]);
  });

  test("a corpus link to the account keeps it fused despite the contradiction", () => {
    const graph = sameLogin(
      { corpusIdentifiers: { emails: [], socialHandles: [{ platform: "github", handle: "fixtureveil", url: "https://github.com/fixtureveil" }] } },
      ["I live in Manchester these days"],
    );
    expect(subjectEmails(graph)).toContain("email:fixtureveil@corp.test");
  });

  test("a consistent or silent corpus keeps it fused", () => {
    expect(subjectEmails(sameLogin({}, ["I live in Tokyo now"]))).toContain("email:fixtureveil@corp.test");
    expect(subjectEmails(sameLogin({}, ["nice weather"]))).toContain("email:fixtureveil@corp.test");
  });
});

describe("identity graph: drift edges", () => {
  test("fixtureveil and fixtureve1l nodes join via a drift edge", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        identifiers: {
          emails: [],
          socialHandles: [
            { platform: "github", handle: "fixtureve1l", url: "https://github.com/fixtureve1l" },
          ],
        },
      }),
    });

    const drift = edgeBetween(graph, "handle:fixtureveil", "handle:fixtureve1l");
    expect(drift).toBeDefined();
    expect(drift!.kind).toBe("drift");
    expect(drift!.strength).toBe(0.7);

    // The drift edge fuses both spellings into the subject person.
    const subject = graph.persons.find((p) => p.isSubject)!;
    expect(subject.handleNodes).toContain("handle:fixtureve1l");
  });
});

describe("identity graph: corpus disclosures", () => {
  test("a corpus mention of a discovered handle creates a disclosure edge into the audited node", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        identifiers: {
          emails: [],
          socialHandles: [
            { platform: "github", handle: "fixturenew", url: "https://github.com/fixturenew" },
          ],
        },
      }),
      corpusTexts: [
        { text: "people always find my alt fixturenew eventually", permalink: "https://reddit.com/r/c/comments/1" },
      ],
    });

    const disclosure = edgeBetween(graph, "handle:fixturenew", "handle:fixtureveil");
    expect(disclosure).toBeDefined();
    expect(disclosure!.kind).toBe("disclosure");
    expect(disclosure!.strength).toBe(0.8);
    expect(disclosure!.evidence).toContain("https://reddit.com/r/c/comments/1");
  });

  test("a common-word handle in plain prose is NOT a disclosure; with handle context it is", () => {
    const input = (text: string): IdentityGraphInput => ({
      username: "fixtureveil",
      webSweep: makeSweep({
        identifiers: {
          emails: [],
          socialHandles: [{ platform: "github", handle: "microsoft", url: "https://github.com/microsoft" }],
        },
      }),
      corpusTexts: [{ text, permalink: "https://reddit.com/r/c/comments/2" }],
    });
    const prose = buildIdentityGraph(input("I interned at Microsoft last summer"));
    expect(prose.edges.filter((e) => e.kind === "disclosure")).toHaveLength(0);
    const disclosed = buildIdentityGraph(input("my github is microsoft, long story"));
    expect(edgeBetween(disclosed, "handle:microsoft", "handle:fixtureveil")?.kind).toBe("disclosure");
  });

  test("URL fragments (/handle/i/x) do NOT create disclosure edges", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        identifiers: {
          emails: [],
          socialHandles: [
            { platform: "github", handle: "fixturenew", url: "https://github.com/fixturenew" },
          ],
        },
      }),
      corpusTexts: [{ text: "see /fixturenew/i/x for the archive mirror" }],
    });

    expect(graph.edges.filter((e) => e.kind === "disclosure")).toHaveLength(0);
  });

  test("a corpus email joins the subject person via a disclosure edge with the permalink as evidence", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      corpusIdentifiers: { emails: ["Veil@Shadow.dev"], socialHandles: [] },
      corpusTexts: [
        { text: "unrelated post", permalink: "/r/a/comments/1/" },
        { text: "reach me at veil@shadow.dev", permalink: "/r/b/comments/2/" },
      ],
    });

    const disclosure = edgeBetween(graph, "email:veil@shadow.dev", "handle:fixtureveil");
    expect(disclosure?.kind).toBe("disclosure");
    expect(disclosure?.strength).toBe(0.8);
    expect(disclosure?.evidence).toEqual(["/r/b/comments/2/"]);
    expect(graph.persons.find((p) => p.isSubject)?.emailNodes).toContain("email:veil@shadow.dev");
  });

  test("vendor and noreply corpus emails never join the subject", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      corpusIdentifiers: { emails: ["abuse@vendor.com", "noreply@vendor.com", "support@vendor.com"], socialHandles: [] },
      corpusTexts: [{ text: "abuse@vendor.com noreply@vendor.com support@vendor.com", permalink: "/r/a/comments/1/" }],
    });

    expect(graph.edges.filter((e) => e.kind === "disclosure")).toHaveLength(0);
    expect(graph.persons.find((p) => p.isSubject)?.emailNodes).toEqual([]);
  });
});

describe("identity graph: email local-part join", () => {
  test("johndoe@gmail.com ties to the johndoe handle node at 0.7", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        identifiers: {
          emails: ["johndoe@gmail.com"],
          socialHandles: [
            { platform: "github", handle: "johndoe", url: "https://github.com/johndoe" },
          ],
        },
      }),
    });

    const join = edgeBetween(graph, "handle:johndoe", "email:johndoe@gmail.com");
    expect(join).toBeDefined();
    expect(join!.kind).toBe("email-of");
    expect(join!.strength).toBe(0.7);
  });
});

describe("identity graph: own-domain email join", () => {
  const sweepWith = (emailSource: string) => makeSweep({
    identifiers: { emails: ["hello@quietsite.dev"], socialHandles: [] },
    identifierSources: { emails: { "hello@quietsite.dev": [emailSource] }, handles: {}, freemail: {} },
  });
  const gitHub = makeGitHub({
    identities: [{
      login: "fixturenew", url: "https://github.com/fixturenew", blog: "https://quietsite.dev",
      commitAuthors: [], commitStats: { scanned: 0, attributed: 0, excluded: 0 },
    }],
  });

  test("an address published on its own domain joins the handle whose profile links the site", () => {
    const graph = buildIdentityGraph({ username: "fixtureveil", webSweep: sweepWith("https://quietsite.dev/contact"), gitHub });
    expect(edgeBetween(graph, "handle:fixturenew", "email:hello@quietsite.dev")?.kind).toBe("email-of");
  });

  test.each([
    "https://quietsite.dev/about",
    "https://www.quietsite.dev/about/",
    "quietsite.dev/about",
    "www.quietsite.dev/about/",
  ])("a profile site path still owns the domain's email: %s", (blog) => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      webSweep: sweepWith("https://www.quietsite.dev/contact"),
      gitHub: makeGitHub({ identities: [{ ...gitHub.identities[0], blog }] }),
    });
    expect(edgeBetween(graph, "handle:fixturenew", "email:hello@quietsite.dev")?.kind).toBe("email-of");
    expect(graph.persons.find((p) => p.handleNodes.includes("handle:fixturenew"))?.emailNodes)
      .toContain("email:hello@quietsite.dev");
    expect(graph.nodes.find((n) => n.kind === "site")?.id).toBe("site:quietsite.dev/about");
  });

  test("own-domain email ownership cannot undo a profile namesake split", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      corpusTexts: [{ text: "I live in Manchester these days" }],
      webSweep: makeSweep({
        identifiers: { emails: ["hello@fixtureveil.dev"], socialHandles: [] },
        identifierSources: { emails: { "hello@fixtureveil.dev": ["https://fixtureveil.dev/contact"] }, handles: {}, freemail: {} },
      }),
      gitHub: makeGitHub({ identities: [{
        login: "fixtureveil", url: "https://github.com/fixtureveil", location: "Tokyo, Japan",
        name: "John Doe", blog: "https://fixtureveil.dev",
        commitAuthors: [], commitStats: { scanned: 0, attributed: 0, excluded: 0 },
      }] }),
    });
    const subject = graph.persons.find((p) => p.isSubject)!;
    expect(subject.handleNodes).toEqual(["handle:fixtureveil"]);
    expect(subject.emailNodes).toEqual([]);
    expect(subject.nameNodes).toEqual([]);
    const namesake = graph.persons.find((p) => p.handleNodes.includes("handle:fixtureveil@github"))!;
    expect(namesake.isSubject).toBe(false);
    expect(namesake.emailNodes).toContain("email:hello@fixtureveil.dev");
    expect(namesake.nameNodes).toContain("name:john doe");
  });

  test("without a known site owner the domain-spelling fallback still joins", () => {
    const graph = buildIdentityGraph({ username: "quietsite", webSweep: sweepWith("https://quietsite.dev/contact") });
    expect(graph.persons.find((p) => p.isSubject)?.emailNodes).toContain("email:hello@quietsite.dev");
  });

  test.each(["notquietsite.dev", "quietsite.dev.evil.test", "sub.quietsite.dev"])(
    "a different profile host does not own the email: %s", (host) => {
      const graph = buildIdentityGraph({
        username: "fixtureveil",
        webSweep: sweepWith("https://quietsite.dev/contact"),
        gitHub: makeGitHub({ identities: [{ ...gitHub.identities[0], blog: `https://${host}/about` }] }),
      });
      expect(edgeBetween(graph, "handle:fixturenew", "email:hello@quietsite.dev")).toBeUndefined();
    },
  );

  test("the same address seen only on another site does not join", () => {
    const graph = buildIdentityGraph({ username: "fixtureveil", webSweep: sweepWith("https://forum.example/thread"), gitHub });
    expect(edgeBetween(graph, "handle:fixturenew", "email:hello@quietsite.dev")).toBeUndefined();
  });
});

describe("identity graph: empty inputs and determinism", () => {
  const empty = (username: string): IdentityGraphInput => ({ username });

  test("empty inputs → just the audited username node; renderers return \"\"", () => {
    const graph = buildIdentityGraph(empty("solo"));
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].id).toBe("handle:solo");
    expect(graph.edges).toHaveLength(0);
    expect(renderIdentityGraphBlock(graph, "solo")).toBe("");
    expect(renderIdentityGraphContextForPrompt(graph, "solo")).toBe("");
  });

  test("same input twice → deep-equal graph", () => {
    const input: IdentityGraphInput = {
      username: "fixtureveil",
      webSweep: makeSweep({
        identifiers: {
          emails: ["johndoe@gmail.com"],
          socialHandles: [
            { platform: "github", handle: "fixturenew", url: "https://github.com/fixturenew" },
            { platform: "x", handle: "fixturenew", url: "https://x.com/fixturenew" },
          ],
        },
        bridgeEvidence: {
          fixturenew: [
            { url: "https://github.com/fixturenew", snippet: "…fixtureveil…", target: "fixtureveil" },
          ],
        },
      }),
      corpusTexts: [{ text: "my alt fixturenew", permalink: "https://reddit.com/r/c/1" }],
    };
    expect(buildIdentityGraph(input)).toEqual(buildIdentityGraph(input));
  });
});

describe("identity graph: rename strength follows bridge confidence", () => {
  const graphFor = (url: string, confidence: number) =>
    buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        bridgeEvidence: {
          fixturenew: [{ url, snippet: "…fixtureveil…", target: "fixtureveil", confidence, reciprocal: false }],
        },
      }),
    });
  const subjectHas = (g: ReturnType<typeof buildIdentityGraph>, id: string) =>
    g.persons.find((p) => p.isSubject)!.handleNodes.includes(id);

  test("a one-way third-party mention (0.5) is recorded but does NOT merge", () => {
    const g = graphFor("https://someblog.example/post", 0.5);
    expect(edgeBetween(g, "handle:fixturenew", "handle:fixtureveil")?.strength).toBe(0.5);
    expect(subjectHas(g, "handle:fixturenew")).toBe(false);
  });

  test("an own-profile bridge (0.8) merges the owner into the subject", () => {
    const g = graphFor("https://github.com/fixturenew", 0.8);
    expect(edgeBetween(g, "handle:fixturenew", "handle:fixtureveil")?.strength).toBe(0.8);
    expect(subjectHas(g, "handle:fixturenew")).toBe(true);
  });
});

describe("identity graph: negative evidence on bridges", () => {
  const bridged = (location: string, posts: string[]) =>
    buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        bridgeEvidence: {
          fixturenew: [{
            url: "https://github.com/fixturenew",
            snippet: "formerly fixtureveil",
            target: "fixtureveil",
            mentionClass: "self-reference",
          }],
        },
      }),
      gitHub: makeGitHub({
        identities: [{
          login: "fixturenew", url: "https://github.com/fixturenew", location,
          commitAuthors: [], commitStats: { scanned: 0, attributed: 0, excluded: 0 },
        }],
      }),
      corpusTexts: posts.map((text, i) => ({ text, permalink: `/r/a/comments/${i}/` })),
    });

  test("a bridged handle whose profile the subject's posts contradict is a namesake", () => {
    const graph = bridged("Tokyo, Japan", ["I live in Manchester these days"]);
    const edge = edgeBetween(graph, "handle:fixturenew", "handle:fixtureveil")!;
    expect(edge.contradicted).toBe(true);
    expect(edge.strength).toBe(0.45);
    expect(graph.persons.find((p) => p.isSubject)!.handleNodes).not.toContain("handle:fixturenew");
    expect(graph.persons.find((p) => p.handleNodes.includes("handle:fixturenew"))?.isSubject).toBe(false);
    expect(renderIdentityGraphBlock(graph, "fixtureveil")).toContain("contradicted by the subject's own posts");
  });

  test("an agreeing profile keeps the bridge fused", () => {
    const graph = bridged("Manchester, UK", ["I live in Manchester these days"]);
    expect(edgeBetween(graph, "handle:fixturenew", "handle:fixtureveil")?.contradicted).toBeUndefined();
    expect(graph.persons.find((p) => p.isSubject)!.handleNodes).toContain("handle:fixturenew");
  });

  test("a silent corpus keeps the bridge fused", () => {
    const graph = bridged("Tokyo, Japan", ["nice weather today"]);
    expect(graph.persons.find((p) => p.isSubject)!.handleNodes).toContain("handle:fixturenew");
  });
});

describe("identity graph: third-party disclosures", () => {
  test("a third-party disclosure is a lead, not a fusion", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        identifiers: {
          emails: [],
          socialHandles: [{ platform: "github", handle: "fixturefriend", url: "https://github.com/fixturefriend" }],
        },
      }),
      corpusTexts: [{ text: "my friend's github is fixturefriend", permalink: "/r/a/comments/1/" }],
    });
    const edge = edgeBetween(graph, "handle:fixturefriend", "handle:fixtureveil")!;
    expect(edge.kind).toBe("disclosure");
    expect(edge.strength).toBe(0.45);
    expect(graph.persons.find((p) => p.isSubject)!.handleNodes).not.toContain("handle:fixturefriend");
  });

  test("a self disclosure still fuses", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        identifiers: {
          emails: [],
          socialHandles: [{ platform: "github", handle: "fixturenew", url: "https://github.com/fixturenew" }],
        },
      }),
      corpusTexts: [{ text: "my github is fixturenew", permalink: "/r/a/comments/1/" }],
    });
    expect(edgeBetween(graph, "handle:fixturenew", "handle:fixtureveil")?.strength).toBe(0.8);
    expect(graph.persons.find((p) => p.isSubject)!.handleNodes).toContain("handle:fixturenew");
  });
});

describe("identity graph: linkage decay", () => {
  test("a chain of two weak bridges does not drag the far end into the subject", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        identifiers: {
          emails: [],
          socialHandles: [
            { platform: "github", handle: "midlink", url: "https://github.com/midlink" },
            { platform: "github", handle: "farlink", url: "https://github.com/farlink" },
            { platform: "x", handle: "farlink", url: "https://x.com/farlink" },
          ],
        },
        bridgeEvidence: {
          midlink: [{ url: "https://blog.example/a", snippet: "formerly fixtureveil", target: "fixtureveil", mentionClass: "self-reference" }],
          farlink: [{ url: "https://blog.example/b", snippet: "formerly midlink", target: "midlink", mentionClass: "self-reference" }],
        },
      }),
    });
    const subject = graph.persons.find((p) => p.isSubject)!;
    expect(subject.handleNodes).toContain("handle:midlink");
    expect(subject.handleNodes).not.toContain("handle:farlink");
    // 0.6 × 0.6 = 0.36 — below the linkage floor.
    expect(graph.persons.find((p) => p.handleNodes.includes("handle:farlink"))?.linkage).toBe(0);
  });

  test("a strong anchor carries a downstream drift spelling", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        identifiers: {
          emails: [],
          socialHandles: [{ platform: "github", handle: "fixtureve1l", url: "https://github.com/fixtureve1l" }],
        },
        bridgeEvidence: {
          fixturenew: [{
            url: "https://dir.example/", snippet: "[fixtureveil](https://x.com/fixturenew)",
            target: "fixtureveil", kind: "anchor-rename", anchorTarget: "fixturenew",
          }],
        },
      }),
    });
    expect(graph.persons.find((p) => p.isSubject)!.handleNodes).toContain("handle:fixtureve1l");
  });
});

describe("identity graph: candidate ranking", () => {
  // Subject: one weak third-party bridge. Namesake: a rich, unlinked profile.
  const ranked = (candidateName?: string) =>
    buildIdentityGraph({
      username: "fixtureveil",
      candidateName,
      webSweep: makeSweep({
        identifiers: {
          emails: [],
          socialHandles: [
            { platform: "github", handle: "weakowner", url: "https://github.com/weakowner" },
            { platform: "github", handle: "richfan", url: "https://github.com/richfan" },
            { platform: "x", handle: "richfan", url: "https://x.com/richfan" },
          ],
        },
        bridgeEvidence: {
          weakowner: [{ url: "https://blog.example/a", snippet: "formerly fixtureveil", target: "fixtureveil", mentionClass: "self-reference", confidence: 0.6 }],
        },
      }),
      gitHub: makeGitHub({
        identities: [{
          login: "richfan", url: "https://github.com/richfan", name: "Rich Fan",
          email: "rich@fan.dev", commitAuthors: [], commitStats: { scanned: 0, attributed: 0, excluded: 0 },
        }],
      }),
    });

  test("a rich namesake outranks a lone weak bridge and the margin is negative", () => {
    const graph = ranked();
    expect(graph.persons[0].isSubject).toBe(false);
    expect(graph.margin).toBeGreaterThan(0);
    expect(renderIdentityGraphBlock(graph, "fixtureveil")).toContain("a namesake outranks the subject person");
    expect(renderIdentityGraphContextForPrompt(graph, "fixtureveil")).toContain("a namesake outranks");
  });

  test("a supplied candidate name lifts the matching person", () => {
    const graph = ranked("Rich Fan");
    const fan = graph.persons.find((p) => p.nameNodes.includes("name:rich fan"))!;
    expect(fan.candidateMatch).toBe(true);
    expect(renderIdentityGraphBlock(graph, "fixtureveil")).toContain("candidate-name match");
  });
});

describe("identity graph: timeline coherence", () => {
  const graphFor = (accountCreated: string, lastSnapshot: string) =>
    buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        bridgeEvidence: {
          fixturenew: [{
            url: "https://github.com/fixturenew", snippet: "formerly fixtureveil",
            target: "fixtureveil", mentionClass: "self-reference", confidence: 0.8,
          }],
        },
      }),
      gitHub: makeGitHub({
        identities: [{
          login: "fixturenew", url: "https://github.com/fixturenew", accountCreated,
          commitAuthors: [], commitStats: { scanned: 0, attributed: 0, excluded: 0 },
        }],
      }),
      archivePass: {
        snapshots: [{
          url: "x.com/fixtureveil/", firstSnapshot: "20190101000000",
          lastSnapshot, count: 3,
        }],
      },
    });

  test("a new account created long after the old handle's last capture is incoherent", () => {
    const graph = graphFor("2024-01-01T00:00:00Z", "20200101000000");
    const edge = edgeBetween(graph, "handle:fixturenew", "handle:fixtureveil")!;
    expect(edge.incoherent).toBe(true);
    expect(edge.strength).toBe(0.45);
    expect(graph.persons.find((p) => p.isSubject)!.handleNodes).not.toContain("handle:fixturenew");
    expect(renderIdentityGraphBlock(graph, "fixtureveil")).toContain("chronologically implausible rename");
  });

  test("a new account created before the old handle went quiet stays coherent", () => {
    const graph = graphFor("2019-06-01T00:00:00Z", "20200101000000");
    const edge = edgeBetween(graph, "handle:fixturenew", "handle:fixtureveil")!;
    expect(edge.incoherent).toBeUndefined();
    expect(graph.persons.find((p) => p.isSubject)!.handleNodes).toContain("handle:fixturenew");
  });

  test("without archive dates the check never fires", () => {
    const graph = buildIdentityGraph({
      username: "fixtureveil",
      webSweep: makeSweep({
        bridgeEvidence: {
          fixturenew: [{ url: "https://github.com/fixturenew", snippet: "formerly fixtureveil", target: "fixtureveil", mentionClass: "self-reference", confidence: 0.8 }],
        },
      }),
      gitHub: makeGitHub({
        identities: [{
          login: "fixturenew", url: "https://github.com/fixturenew", accountCreated: "2024-01-01T00:00:00Z",
          commitAuthors: [], commitStats: { scanned: 0, attributed: 0, excluded: 0 },
        }],
      }),
    });
    expect(edgeBetween(graph, "handle:fixturenew", "handle:fixtureveil")?.incoherent).toBeUndefined();
  });
});
