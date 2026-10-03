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
        bridgeEvidence: {
          dirpage: [
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
    expect(anchor!.from).toBe("handle:dirpage");
    expect(anchor!.to).toBe("handle:fixtureveil");
    expect(anchor!.strength).toBe(1.0);
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
    expect(drift!.strength).toBe(0.6);

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
});

describe("identity graph: email local-part join", () => {
  test("johndoe@gmail.com ties to the johndoe handle node at 0.6", () => {
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
    expect(join!.strength).toBe(0.6);
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
