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
  test("collects texts + normalized permalinks from raw items", () => {
    const m = buildCorpusManifest(CORPUS_ITEMS);
    expect(m.texts.length).toBe(3);
    expect(m.permalinks.has("/r/hyderabad/comments/aaa/title")).toBe(true);
    expect(m.permalinks.has("/r/programming/comments/bbb/title")).toBe(true);
    expect(m.permalinks.has("/r/askreddit/comments/ccc/til/x/y")).toBe(true);
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
