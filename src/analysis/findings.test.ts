import { describe, expect, test } from "bun:test";
import {
  buildCorpusManifest,
  validateStructuredFindings,
  type StructuredFindings,
  type Finding,
  type CorpusManifest,
} from "./findings.ts";
import { extractDirectIdentifiers } from "./extract.ts";

function mkFinding(
  category: Finding["category"],
  evidence: Array<{ quote: string; permalink: string }>,
  claim = "test claim",
): Finding {
  return {
    category,
    claim,
    confidence: "medium",
    rationale: "r",
    evidence,
    remediation: "fix",
  };
}

function mkStructured(findings: Finding[], risk: StructuredFindings["overallRisk"] = "medium"): StructuredFindings {
  return { overallRisk: risk, summary: "s", findings };
}

const CORPUS_ITEMS = [
  { body: "I live in Hyderabad near the old city.", title: "", permalink: "/r/hyderabad/comments/aaa/title/" },
  { body: "My github is https://github.com/janedoe", title: "side project", permalink: "/r/programming/comments/bbb/title/" },
  { body: "deleted body", title: "", permalink: "/r/askreddit/comments/ccc/til/x/y/" },
];

describe("buildCorpusManifest", () => {
  test("maps normalized permalinks to their item text", () => {
    const m = buildCorpusManifest(CORPUS_ITEMS);
    expect(m.texts.length).toBe(3);
    expect(m.items.get("/r/hyderabad/comments/aaa/title")).toContain("Hyderabad");
    expect(m.items.get("/r/programming/comments/bbb/title")).toContain("github.com/janedoe");
    expect(m.items.has("/r/askreddit/comments/ccc/til/x/y")).toBe(true);
  });

  test("an external link-post URL is corpus text; Reddit-hosted media is not", () => {
    const linkPost = { title: "my weekend project", selftext: "", url: "https://github.com/janedoe", permalink: "/r/rust/comments/eee/proj/" };
    const media = { title: "pic", selftext: "", url: "https://i.redd.it/abc.png", permalink: "/r/pics/comments/fff/pic/" };
    const m = buildCorpusManifest([linkPost, media]);
    const handles = extractDirectIdentifiers(m.texts).socialHandles.map((h) => `${h.platform}:${h.handle}`);
    expect(handles).toContain("github:janedoe");
    expect(m.items.get("/r/pics/comments/fff/pic")).not.toContain("redd.it");
  });

  test("post bodies (selftext) are scanned and can validate quotes", () => {
    const post = { title: "Moving soon", selftext: "Leaving Pune for a job at Acme next month", permalink: "/r/pune/comments/ddd/moving/" };
    const m = buildCorpusManifest([post]);
    expect(extractDirectIdentifiers(buildCorpusManifest([{ ...post, selftext: "reach me at me@example.dev" }]).texts).emails).toEqual(["me@example.dev"]);
    const sf = validateStructuredFindings(mkStructured([mkFinding("employer_or_school", [{ quote: "a job at Acme", permalink: post.permalink }])]), m);
    expect(sf.findings[0].evidence).toHaveLength(1);
  });
});

describe("validateStructuredFindings", () => {
  const manifest: CorpusManifest = buildCorpusManifest(CORPUS_ITEMS);

  test("keeps evidence whose quote + permalink are in the corpus", () => {
    const sf = mkStructured([
      mkFinding("location", [
        { quote: "I live in Hyderabad near the old city.", permalink: "https://reddit.com/r/hyderabad/comments/aaa/title/" },
      ]),
    ]);
    const v = validateStructuredFindings(sf, manifest);
    expect(v.findings[0].evidence.length).toBe(1);
    expect(v.evidenceValidation?.supported).toBe(1);
    expect(v.evidenceValidation?.unsupported).toBe(0);
  });

  test("drops evidence whose permalink is NOT in the corpus (zero weight)", () => {
    const sf = mkStructured([
      mkFinding("location", [
        { quote: "I live in Hyderabad near the old city.", permalink: "https://reddit.com/r/fabricated/comments/zzz/never/" },
      ]),
    ]);
    const v = validateStructuredFindings(sf, manifest);
    expect(v.findings[0].evidence.length).toBe(0);
    expect(v.evidenceValidation?.unsupported).toBe(1);
  });

  test("drops evidence whose quote does NOT appear in the corpus", () => {
    const sf = mkStructured([
      mkFinding("real_name", [
        { quote: "My real name is entirely invented by the model.", permalink: "https://www.reddit.com/r/hyderabad/comments/aaa/title/" },
      ]),
    ]);
    const v = validateStructuredFindings(sf, manifest);
    expect(v.findings[0].evidence.length).toBe(0);
    expect(v.evidenceValidation?.unsupported).toBe(1);
  });

  test("tolerates post-vs-comment permalink depth via prefixing", () => {
    // corpus stores the comment permalink (.../x/y); a shorter post permalink should still match.
    const sf = mkStructured([
      mkFinding("location", [
        { quote: "deleted body", permalink: "https://reddit.com/r/askreddit/comments/ccc/til/" },
      ]),
    ]);
    const v = validateStructuredFindings(sf, manifest);
    expect(v.findings[0].evidence.length).toBe(1);
    // rewritten to the matched item so corroboration can find its text
    expect(v.findings[0].evidence[0].permalink).toBe("https://reddit.com/r/askreddit/comments/ccc/til/x/y");
  });

  test("a post-permalink citation of a quote in the post validates even when a comment shares the thread", () => {
    const m = buildCorpusManifest([
      { title: "Moving", selftext: "Leaving Pune soon", permalink: "/r/pune/comments/ddd/moving/" },
      { body: "thanks all", permalink: "/r/pune/comments/ddd/moving/c1/" },
    ]);
    const v = validateStructuredFindings(mkStructured([
      mkFinding("location", [{ quote: "Leaving Pune", permalink: "https://www.reddit.com/r/pune/comments/ddd/moving/c1/" }]),
    ]), m);
    expect(v.findings[0].evidence[0]?.permalink).toBe("https://reddit.com/r/pune/comments/ddd/moving");
  });

  test("drops a real quote paired with an unrelated real permalink", () => {
    const v = validateStructuredFindings(mkStructured([
      mkFinding("location", [{ quote: "I live in Hyderabad", permalink: "https://reddit.com/r/programming/comments/bbb/title/" }]),
    ]), manifest);
    expect(v.findings[0].evidence.length).toBe(0);
    expect(v.evidenceValidation?.dropped[0]).toContain("quote not in cited item");
  });

  test("drops a subreddit-only permalink (it would prefix-match every item)", () => {
    const v = validateStructuredFindings(mkStructured([
      mkFinding("location", [{ quote: "I live in Hyderabad", permalink: "https://reddit.com/r/hyderabad" }]),
    ]), manifest);
    expect(v.findings[0].evidence.length).toBe(0);
    expect(v.evidenceValidation?.dropped[0]).toContain("permalink not in corpus");
  });

  test("short quotes are validated against the cited item only", () => {
    const m = buildCorpusManifest([
      { body: "I'm 24 and broke", permalink: "/r/a/comments/111/x/" },
      { body: "nothing here", permalink: "/r/a/comments/222/y/" },
    ]);
    const v = validateStructuredFindings(mkStructured([
      mkFinding("age_or_dob", [
        { quote: "I'm 24", permalink: "/r/a/comments/111/x/" },
        { quote: "I'm 24", permalink: "/r/a/comments/222/y/" },
      ]),
    ]), m);
    expect(v.findings[0].evidence.map((e) => e.permalink)).toEqual(["https://reddit.com/r/a/comments/111/x"]);
    expect(v.evidenceValidation?.unsupported).toBe(1);
  });

  test("without a corpus manifest, only malformed-permalink shape checks run (quotes unchecked)", () => {
    const sf = mkStructured([
      mkFinding("location", [
        { quote: "This quote exists nowhere but cannot be checked without a corpus.", permalink: "https://reddit.com/r/hyderabad/comments/aaa/title/" },
        { quote: "ok", permalink: "not-a-url" },
      ]),
    ]);
    const v = validateStructuredFindings(sf); // no manifest
    // malformed permalink dropped; the unverifiable quote is retained (cannot check)
    expect(v.findings[0].evidence.length).toBe(1);
    expect(v.evidenceValidation?.unsupported).toBe(1);
  });

  test("an empty manifest (run holds no Reddit text) gives every citation zero weight", () => {
    const sf = mkStructured([
      mkFinding("location", [
        { quote: "I moved to Hyderabad last year for work.", permalink: "https://reddit.com/r/hyderabad/comments/aaa/title/" },
      ], "lives in Hyderabad"),
    ]);
    const v = validateStructuredFindings(sf, buildCorpusManifest([]));
    expect(v.findings[0].claim).toBe("lives in Hyderabad");
    expect(v.findings[0].evidence.length).toBe(0);
    expect(v.evidenceValidation?.unsupported).toBe(1);
  });

  test("a finding keeps its claim when all evidence is stripped (zero weight, not deletion)", () => {
    const sf = mkStructured([
      mkFinding("location", [{ quote: "nope not real", permalink: "https://reddit.com/r/x/comments/zzz/no/" }], "lives somewhere"),
    ]);
    const v = validateStructuredFindings(sf, manifest);
    expect(v.findings.length).toBe(1);
    expect(v.findings[0].claim).toBe("lives somewhere");
    expect(v.findings[0].evidence.length).toBe(0);
  });
});

describe("corpus coverage (identifiers in filtered-out items are still found)", () => {
  test("a manifest built from RAW items finds an identifier the heuristic filter would drop", () => {
    // Heuristic filtering would drop a tiny/noise comment, but the manifest is
    // built from the FULL raw history — so an email living only in that item
    // is still captured by deterministic extraction.
    const rawItems = [
      { body: "lol same", title: "", permalink: "/r/x/comments/1/a/" }, // noise, would be filtered
      { body: "email me at hidden@proton.me please", title: "", permalink: "/r/x/comments/2/b/" }, // filtered-out but carries the leak
    ];
    const manifest = buildCorpusManifest(rawItems);
    const ids = extractDirectIdentifiers(manifest.texts, "targetuser");
    expect(ids.emails).toContain("hidden@proton.me");
  });
});
