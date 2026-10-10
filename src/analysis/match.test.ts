/**
 * Table tests for the shared matching rules: bridge-mode and disclosure-mode
 * mention detection, the rank boost built on them, name and mailbox checks,
 * and the platform table's shared reject lists.
 */

import { describe, expect, test } from "bun:test";
import {
  disclosesHandle,
  findHandleMentions,
  isContentlessEmail,
  isReservedProfilePath,
  isRoleMailbox,
  isSeededHandleWord,
  isVendorEmail,
  mentionsHandle,
  nameLooksReal,
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
