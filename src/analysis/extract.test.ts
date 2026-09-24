import { describe, expect, test } from "bun:test";
import { deobfuscateEmails, extractDirectIdentifiers, extractEmails, extractSocialHandles, renderModelMentionedBlock } from "./extract.ts";

describe("deterministic identifier extraction", () => {
  test("deobfuscates and filters common email false positives", () => {
    const text = "Reach me at Jane [at] Example [dot] ORG, no-reply@users.noreply.github.com, test@example.com, root@1.2.3";
    expect(deobfuscateEmails("jane (at) example (dot) org")).toBe("jane@example.org");
    expect(extractEmails(text)).toEqual(["jane@example.org"]);
  });

  test("extracts social profile handles and rejects common platform routes", () => {
    const handles = extractSocialHandles([
      "https://github.com/octocat",
      "https://github.com/issues",
      "https://x.com/search",
      "https://twitter.com/some_user/status/1",
      "https://linkedin.com/in/jane-doe",
      "https://instagram.com/accounts/login",
    ].join("\n"));

    expect(handles.map((h) => `${h.platform}:${h.handle}`)).toEqual([
      "linkedin:jane-doe",
      "x:some_user",
      "github:octocat",
    ]);
  });

  test("drops the audited reddit handle from direct identifiers", () => {
    const result = extractDirectIdentifiers([
      "https://old.reddit.com/user/target_user",
      "https://github.com/target-user",
      "https://reddit.com/u/other_user",
    ], "target_user");

    expect(result.socialHandles.map((h) => `${h.platform}:${h.handle}`)).toEqual([
      "github:target-user",
      "reddit:other_user",
    ]);
  });
});

describe("model-mentioned identifiers stay unverified and separate", () => {
  test("a model-only email is rendered as unverified; a deterministic one is omitted from the block", () => {
    const deterministic = extractDirectIdentifiers(["real@gmail.com https://github.com/realhandle"], "u");
    // The model mentioned a hallucinated email + the real one + a new handle.
    const modelMentioned = extractDirectIdentifiers(
      ["report text: hallucinated@fake.com real@gmail.com https://x.com/newhandle"],
      "u",
    );
    const block = renderModelMentionedBlock(modelMentioned, deterministic);
    // hallucinated + newhandle are model-only → appear, clearly labeled.
    expect(block).toContain("hallucinated@fake.com");
    expect(block).toContain("newhandle");
    expect(block).toContain("Model-Mentioned");
    // real@gmail.com is also deterministic → must NOT clutter the unverified block.
    expect(block).not.toContain("real@gmail.com");
    expect(block).not.toContain("realhandle");
  });

  test("returns empty when the model mentioned nothing beyond deterministic layers", () => {
    const deterministic = extractDirectIdentifiers(["real@gmail.com"], "u");
    const modelMentioned = extractDirectIdentifiers(["real@gmail.com"], "u");
    expect(renderModelMentionedBlock(modelMentioned, deterministic)).toBe("");
  });
});
