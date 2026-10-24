/**
 * Table tests for the shared matching rules: bridge-mode and disclosure-mode
 * mention detection, the rank boost built on them, name and mailbox checks,
 * and the platform table's shared reject lists.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyMention,
  disclosureKind,
  disclosesHandle,
  findHandleMentions,
  isContentlessEmail,
  isReservedProfilePath,
  isRoleMailbox,
  isSeededHandleWord,
  isVendorEmail,
  mentionsHandle,
  nameLooksReal,
  statesResidence,
} from "./match.ts";
import { scoreItem } from "./rank.ts";
import type { FilteredItem } from "../types.ts";

describe("mentionsHandle (bridge mode)", () => {
  const cases: Array<[string, string, boolean]> = [
    ["formerly fixtureveil, now elsewhere", "fixtureveil", true],
    ["ping @fixtureveil for access", "fixtureveil", true],
    ["[fixtureveil] (old badge)", "fixtureveil", true],
    ["old: https://x.com/fixtureveil", "fixtureveil", true],
    ["old: github.com/fixtureveil/", "fixtureveil", true],
    ["see u/fixtureveil", "fixtureveil", true],
    ["youtube.com/@fixtureveil", "fixtureveil", true],
    ["FIXTUREVEIL in caps", "fixtureveil", true],
    // hyphens join handle tokens
    ["I am john-dev on github", "john", false],
    ["I am dev-john on github", "john", false],
    // emails: local part and domain
    ["mail fixtureveil@gmail.com", "fixtureveil", false],
    ["mail me@fixtureveil.dev", "fixtureveil", false],
    // URL fragments, query params, slash-joined prose
    ["see https://example.com/fixtureveil/i/x", "fixtureveil", false],
    ["see /fixtureveil/i/x", "fixtureveil", false],
    ["vote ?id=fixtureveil please", "fixtureveil", false],
    ["worked at Google/fixtureveil", "fixtureveil", false],
    // run-ons
    ["fixtureveilx is someone else", "fixtureveil", false],
    ["barcode scanner", "code", false],
  ];
  for (const [text, handle, want] of cases) {
    test(`${JSON.stringify(text)} ${want ? "mentions" : "does not mention"} ${handle}`, () => {
      expect(mentionsHandle(text, handle)).toBe(want);
    });
  }

  test("findHandleMentions returns offsets, capped", () => {
    expect(findHandleMentions("a abc b abc c abc d abc", "abc", 3)).toEqual([2, 8, 14]);
  });
});

describe("disclosesHandle (disclosure mode)", () => {
  const cases: Array<[string, string, boolean]> = [
    ["I interned at Microsoft last summer", "microsoft", false],
    ["Microsoft is hiring again", "microsoft", false],
    ["my github is microsoft, long story", "microsoft", true],
    ["my discord: nightowl42", "nightowl42", true],
    ["add me on steam, nightowl42", "nightowl42", true],
    ["nightowl42 on twitch most nights", "nightowl42", true],
    ["find me as nightowl42", "nightowl42", true],
    ["ping @nightowl42 anytime", "nightowl42", true],
    ["the user u/nightowl42 posted that", "nightowl42", true],
    ["the user [nightowl42] posted that", "nightowl42", false],
    ["see /nightowl42/i/x for the thread", "nightowl42", false],
    // a platform-table profile URL is the regex extractor's observation, not a verbal disclosure
    ["my github is github.com/nightowl42", "nightowl42", false],
    ["email nightowl42@gmail.com on github", "nightowl42", false],
  ];
  for (const [text, handle, want] of cases) {
    test(`${JSON.stringify(text)} ${want ? "discloses" : "does not disclose"} ${handle}`, () => {
      expect(disclosesHandle(text, handle) >= 0).toBe(want);
    });
  }
});

describe("classifyMention (bridge mode)", () => {
  const cases: Array<[string, string, "self-reference" | "ambient"]> = [
    ["Previously known as fixtureveil", "fixtureveil", "self-reference"],
    ["formerly fixtureveil, now elsewhere", "fixtureveil", "self-reference"],
    ["my old account was fixtureveil", "fixtureveil", "self-reference"],
    ["find me now as fixtureveil", "fixtureveil", "self-reference"],
    ["Reddit: fixtureveil", "fixtureveil", "self-reference"],
    // a link list / shoutout names the handle without claiming it
    ["People worth following: fixtureveil, otherdev, thirddev", "fixtureveil", "ambient"],
    ["inspired by fixtureveil and others", "fixtureveil", "ambient"],
    // a third-party cue beats the nearby platform word
    ["my friend's github is fixtureveil", "fixtureveil", "ambient"],
  ];
  for (const [text, handle, want] of cases) {
    test(`${JSON.stringify(text)} → ${want}`, () => {
      expect(classifyMention(text, handle)).toBe(want);
    });
  }
});

describe("disclosureKind (disclosure mode)", () => {
  test("first-person possession is a self disclosure", () => {
    expect(disclosureKind("my github is nightowl42", "nightowl42")).toEqual({ kind: "self", index: 13 });
  });

  test("a third-party cue downgrades the disclosure", () => {
    expect(disclosureKind("my friend's github is nightowl42", "nightowl42")?.kind).toBe("third-party");
  });

  test("a bare prose mention is not a disclosure", () => {
    expect(disclosureKind("I interned at Microsoft", "microsoft")).toBeNull();
  });
});

describe("statesResidence (first-person residence)", () => {
  test.each([
    ["I live in San Francisco and the rent is brutal.", true],
    ["i'm based in pune these days", true],
    ["We moved to San Francisco last year — I moved to San Francisco too", true],
    ["I visited San Francisco once", false],
    ["news from San Francisco", false],
    ["I live in San Franciscobay", false],
    ["Can I live in Pune on 30k a month?", false],
    ["If I moved to Pune, how much would rent cost?", false],
    ["If I moved to Pune, I would need a new job.", false],
    ["Suppose I live in Pune with that salary.", false],
    ["Could I live in Pune on that salary", false],
    ["I live in Pune? No, I live in Mumbai.", false],
    ["I live in Pune. Can you recommend a restaurant?", true],
    ["I live in Pune, can you recommend a restaurant?", true],
    ["If you need my location, I live in Pune.", true],
    ["If I moved to Mumbai, rent would rise. I live in Pune now.", true],
  ])("%p → %p", (text, expected) => {
    const place = text.toLowerCase().includes("pune") ? "Pune" : "San Francisco";
    expect(statesResidence(text, place) >= 0).toBe(expected);
  });

  test("a hypothetical match does not hide a later assertion or change its offset", () => {
    for (const text of [
      "Can I live in Pune on 30k? I live in Pune already.",
      "If I moved to Pune, rent would rise, but I live in Pune already.",
    ]) {
      expect(statesResidence(text, "Pune")).toBe(text.lastIndexOf("Pune"));
    }
  });
});

describe("rank known-handle boost uses the token matcher", () => {
  const item = (body: string): FilteredItem =>
    ({ body, title: "", subreddit: "misc", created_utc: 0, permalink: "/r/misc/1" }) as unknown as FilteredItem;
  const ctx = (keys: string[]) => ({ keywordWeights: [], subreddits: [], knownHandleKeys: keys });
  const boost = (body: string, key: string) => scoreItem(item(body), ctx([key])) - scoreItem(item(body), ctx([]));

  test("separator spelling john_doe matches the stripped key johndoe", () => {
    expect(boost("I'm john_doe everywhere", "johndoe")).toBe(40);
  });
  test("a key never matches inside a longer word (barcode ⊅ code)", () => {
    expect(boost("bought a barcode scanner", "code")).toBe(0);
  });
});

describe("names, mailboxes, reserved words, platform paths", () => {
  test("nameLooksReal", () => {
    expect(nameLooksReal("Rohan Sharma", "rsharma")).toBe(true);
    expect(nameLooksReal("John Doe", "john_doe")).toBe(false); // handle echo
    expect(nameLooksReal("John Doe")).toBe(true); // GitHub no-handle mode
    expect(nameLooksReal("0x crypto whale")).toBe(false);
    expect(nameLooksReal("fixturenew")).toBe(false);
  });
  test("mailboxes", () => {
    expect(isRoleMailbox("abuse@vendor.com")).toBe(true);
    expect(isRoleMailbox("jane@vendor.com")).toBe(false);
    expect(isVendorEmail("ab1@x.com")).toBe(true);
    expect(isContentlessEmail("1+me@users.noreply.github.com")).toBe(true);
    expect(isContentlessEmail("dependabot[bot]@example.com")).toBe(true);
    expect(isContentlessEmail("noreply@site.dev")).toBe(true);
    expect(isContentlessEmail("jane@site.dev")).toBe(false);
  });
  test("reserved words and profile paths", () => {
    expect(isSeededHandleWord("GitHub")).toBe(true);
    expect(isSeededHandleWord("trending_repos")).toBe(true);
    expect(isSeededHandleWord("ab")).toBe(true);
    expect(isSeededHandleWord("fixturenew")).toBe(false);
    expect(isReservedProfilePath("github", "gist")).toBe(true);
    expect(isReservedProfilePath("instagram", "reels")).toBe(true);
    expect(isReservedProfilePath("github", "fixturenew")).toBe(false);
  });
});
