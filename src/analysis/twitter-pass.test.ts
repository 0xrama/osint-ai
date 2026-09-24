import { describe, expect, test } from "bun:test";
import {
  assertReadOnly,
  fetchTwitterUser,
  generateDriftVariants,
  isDriftVariant,
  isReclaimedHandle,
  levenshtein,
  rankAltCandidates,
  runTwitterPass,
  type TwitterDeps,
  type TwitterUserProfile,
} from "./twitter-pass.ts";

/* ── Fixture builders (no network, no real CLI) ────────────────────────── */

const profile = (partial: Partial<TwitterUserProfile> & { screenName: string }): TwitterUserProfile => ({
  id: `id-${partial.screenName}`,
  name: partial.screenName,
  bio: "",
  location: "",
  url: "",
  followers: 0,
  following: 0,
  tweets: 0,
  likes: 0,
  verified: false,
  profileImageUrl: "",
  createdAt: "",
  ...partial,
});

const ok = (data: unknown): object =>
  ({ ok: true, schema_version: "1", data });

const notFound = (): object =>
  ({ ok: false, schema_version: "1", error: { code: "not_found", message: "User not found" } });

/** Fake exec: routes by subcommand and returns deterministic envelopes. The
 *  override values are the raw envelope OBJECTS; fakeExec JSON-stringifies
 *  them like the CLI's --json output would. */
function fakeExec(overrides: Record<string, unknown> = {}): TwitterDeps["exec"] {
  return async (args) => {
    const cmd = args[0];
    const handle = args[1];
    const data = overrides[`${cmd}:${handle}`] ?? overrides[cmd];
    if (data === undefined) {
      return {
        stdout: cmd === "status"
          ? JSON.stringify(ok({ authenticated: true, user: { screenName: "burner0x", username: "burner0x" } }))
          : JSON.stringify(notFound()),
        code: 0,
      };
    }
    return { stdout: JSON.stringify(data), code: 0 };
  };
}

/** JSON-stringify a raw payload (used with deps.exec fakes directly). */
const envelope = (payload: unknown): string => JSON.stringify(payload);

/* ── Read-only gate ────────────────────────────────────────────────────── */

describe("read-only allowlist", () => {
  test("read subcommands are permitted", () => {
    for (const cmd of ["status", "whoami", "user", "user-posts", "following", "followers", "search"]) {
      expect(() => assertReadOnly([cmd, "--json"])).not.toThrow();
    }
  });

  test("write subcommands are refused", () => {
    for (const cmd of ["tweet", "post", "reply", "like", "retweet", "follow", "unfollow", "delete", "bookmark"]) {
      expect(() => assertReadOnly([cmd, "hello"])).toThrow(/read-only by design/);
    }
  });
});

/* ── Pure helpers ──────────────────────────────────────────────────────── */

describe("drift variants", () => {
  test("generates digit/letter confusables", () => {
    const v = generateDriftVariants("fixtureveil");
    expect(v).toContain("fixtureveil");
    expect(v).toContain("fixtureve1l");
    expect(v).toContain("fixtur3veil");
    expect(v).toContain("fixturevei1");
  });

  test("isDriftVariant matches fixtureve1l ↔ fixtureveil", () => {
    expect(isDriftVariant("fixtureve1l", "fixtureveil")).toBe(true);
    expect(isDriftVariant("john", "j0hn")).toBe(true);
    expect(isDriftVariant("john", "jane")).toBe(false);
  });

  test("levenshtein basics", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("fixturenew", "fixtureew")).toBe(1);
    expect(levenshtein("same", "same")).toBe(0);
  });
});

describe("isReclaimedHandle", () => {
  test("account created after subject timeline → reclaimed", () => {
    expect(isReclaimedHandle("2025-01-01T00:00:00Z", "2020-01-01T00:00:00Z")).toBe(true);
  });

  test("account created before/around subject timeline → not reclaimed", () => {
    expect(isReclaimedHandle("2019-01-01T00:00:00Z", "2020-01-01T00:00:00Z")).toBe(false);
    expect(isReclaimedHandle("2020-06-01T00:00:00Z", "2020-01-01T00:00:00Z")).toBe(false);
  });

  test("missing dates are not reclaimed", () => {
    expect(isReclaimedHandle(undefined, "2020-01-01T00:00:00Z")).toBe(false);
    expect(isReclaimedHandle("2025-01-01T00:00:00Z", undefined)).toBe(false);
  });
});

/* ── Follow-graph triage ───────────────────────────────────────────────── */

describe("rankAltCandidates", () => {
  const knownHandles = ["fixtureveil", "fixturenew"];
  const subject = "2020-01-01T00:00:00Z";

  test("0x-scheme username + real-name display name ranks high", () => {
    const following = [
      profile({ screenName: "0xfixture", name: "Rohan Sharma", createdAtISO: "2020-06-01T00:00:00Z" }),
      profile({ screenName: "randomfan42", name: "Crypto Fan", createdAtISO: "2023-01-01T00:00:00Z" }),
      profile({ screenName: "newsbot", name: "News Bot", createdAtISO: "2019-01-01T00:00:00Z" }),
    ];
    const ranked = rankAltCandidates(following, { knownHandles, subjectCreatedISO: subject });
    expect(ranked.length).toBe(1);
    expect(ranked[0].profile.screenName).toBe("0xfixture");
    expect(ranked[0].score).toBeGreaterThanOrEqual(3);
    expect(ranked[0].reasons.some((r) => r.includes("real name"))).toBe(true);
  });

  test("drift variant of a known handle ranks high", () => {
    const ranked = rankAltCandidates(
      [profile({ screenName: "fixtureve1l", name: "0x Veil" })],
      { knownHandles },
    );
    expect(ranked.length).toBe(1);
    expect(ranked[0].reasons.some((r) => r.includes("drift variant"))).toBe(true);
  });

  test("known handles themselves are skipped", () => {
    const ranked = rankAltCandidates(
      [profile({ screenName: "fixturenew", name: "Current Handle" })],
      { knownHandles },
    );
    expect(ranked).toEqual([]);
  });

  test("excluded (operator) handles are skipped", () => {
    const ranked = rankAltCandidates(
      [profile({ screenName: "burner0x", name: "Burner Account" })],
      { knownHandles, excludeHandles: ["burner0x"] },
    );
    expect(ranked).toEqual([]);
  });

  test("bio mentioning a known handle scores", () => {
    const ranked = rankAltCandidates(
      [profile({ screenName: "totallyunrelated", name: "Totally Unrelated", bio: "alt of fixtureveil btw" })],
      { knownHandles },
    );
    expect(ranked.length).toBe(1);
    expect(ranked[0].reasons.some((r) => r.includes("bio mentions"))).toBe(true);
  });
});

/* ── The pass (DI fake exec) ───────────────────────────────────────────── */

describe("runTwitterPass", () => {
  const deps: TwitterDeps = {
    exec: fakeExec({
      "user:fixturenew": ok(profile({
        screenName: "fixturenew",
        name: "fixturenew",
        bio: "contact: fixturenew@fixture.test | https://github.com/fixturenew",
        location: "Hyderabad",
        url: "https://example.com",
        following: 2,
        createdAt: "Sun Jun 14 04:10:38 +0000 2020",
        createdAtISO: "2020-06-14T04:10:38Z",
      })),
      "following:fixturenew": ok({
        users: [
          profile({ screenName: "0xfixture", name: "Rohan Sharma", createdAtISO: "2020-06-01T00:00:00Z" }),
          profile({ screenName: "cryptofan", name: "Crypto Fan", createdAtISO: "2023-01-01T00:00:00Z" }),
        ],
      }),
      "user-posts:0xfixture": ok({
        tweets: [{ text: "shipped v2 — site: https://rohan.example.com" }],
      }),
      "user:fixtureveil": ok(profile({
        screenName: "fixtureveil",
        name: "fixtureveil crypto",
        createdAt: "Wed Jan 01 00:00:00 +0000 2025",
        createdAtISO: "2025-01-01T00:00:00Z",
      })),
    }),
  };

  test("profiles, alt candidates, identifiers, reclaimed flags, operator exclusion", async () => {
    const result = await runTwitterPass(
      ["fixturenew", "fixtureveil"],
      { subjectCreatedISO: "2020-01-01T00:00:00Z", deps },
      () => {},
    );

    // fixturenew profile captured with bio identifiers.
    const renamedProfile = result.results.find((r) => r.seed === "fixturenew");
    expect(renamedProfile?.profile?.location).toBe("Hyderabad");
    expect(renamedProfile?.reclaimed).toBe(false);
    expect(result.identifiers.emails).toContain("fixturenew@fixture.test");
    expect(result.identifiers.socialHandles.some((h) => h.platform === "github" && h.handle === "fixturenew")).toBe(true);

    // Alt candidate discovered via the following list.
    expect(renamedProfile?.altCandidates.length).toBe(1);
    expect(renamedProfile?.altCandidates[0].profile.screenName).toBe("0xfixture");
    expect(renamedProfile?.altCandidates[0].tweetSamples?.join(" ")).toContain("rohan.example.com");

    // fixtureveil (created 2025, subject reddit 2020) → reclaimed warning.
    const veil = result.results.find((r) => r.seed === "fixtureveil");
    expect(veil?.reclaimed).toBe(true);

    // Operator burner account excluded from identifiers.
    expect(result.operatorHandle).toBe("burner0x");
    expect(result.identifiers.socialHandles.some((h) => h.handle.toLowerCase() === "burner0x")).toBe(false);
  });

  test("missing profiles degrade to empty results, never throw", async () => {
    const result = await runTwitterPass(["ghosthandle"], { deps: { exec: fakeExec({}) } }, () => {});
    expect(result.results.length).toBe(1);
    expect(result.results[0].profile).toBeUndefined();
    expect(result.identifiers.emails).toEqual([]);
  });

  test("failing exec swallows per-handle errors", async () => {
    const bad: TwitterDeps = {
      exec: async () => { throw new Error("spawn failed"); },
    };
    const result = await runTwitterPass(["anything"], { deps: bad }, () => {});
    expect(result.results.length).toBe(1);
    expect(result.results[0].profile).toBeUndefined();
  });
});

/* ── Fetcher envelope parsing (shape contract with twitter-cli) ────────── */

describe("fetchTwitterUser", () => {
  test("parses the twitter-cli SCHEMA.md envelope and normalizes camelCase", async () => {
    const deps: TwitterDeps = {
      exec: async () => ({
        code: 0,
        stdout: envelope(ok({
          id: "123",
          name: "Rohan Sharma",
          screenName: "0xfixture",
          bio: "infosec",
          location: "Bangalore",
          url: "https://rohan.dev",
          followers: 42,
          following: 7,
          tweets: 100,
          likes: 3,
          verified: false,
          profileImageUrl: "",
          createdAt: "Mon Jan 01 00:00:00 +0000 2020",
          createdAtISO: "2020-01-01T00:00:00Z",
        })),
      }),
    };
    const u = await fetchTwitterUser("@0xfixture", deps);
    expect(u?.screenName).toBe("0xfixture");
    expect(u?.name).toBe("Rohan Sharma");
    expect(u?.followers).toBe(42);
    expect(u?.createdAtISO).toBe("2020-01-01T00:00:00Z");
  });

  test("not_found envelope → null", async () => {
    const deps: TwitterDeps = { exec: async () => ({ code: 0, stdout: envelope(notFound()) }) };
    expect(await fetchTwitterUser("nope", deps)).toBeNull();
  });

  test("non-zero exit → null", async () => {
    const deps: TwitterDeps = { exec: async () => ({ code: 1, stdout: "" }) };
    expect(await fetchTwitterUser("nope", deps)).toBeNull();
  });
});
