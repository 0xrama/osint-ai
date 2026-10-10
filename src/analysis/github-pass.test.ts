import { describe, expect, test } from "bun:test";
import { buildGitHubDepsFromFixture, runGitHubPass, selectOwnerCommits, type GitHubPassDeps } from "./github-pass.ts";

/** Build a GitHub commits-API-shaped object from the git-author fields + the
 *  resolved GitHub author login (what the API returns as `c.author`). */
function commit(name: string, email: string, authorLogin: string | null, date = "2024-01-01T00:00:00Z") {
  return {
    sha: `${name}-${authorLogin}`.toLowerCase(),
    commit: { author: { name, email, date } },
    author: authorLogin ? { login: authorLogin } : null,
  };
}

describe("selectOwnerCommits (author-login verification)", () => {
  test("attributes only commits whose GitHub author login matches the account", () => {
    const res = selectOwnerCommits(
      [
        commit("Jane Doe", "jane@personal.com", "janedoe"), // owner
        commit("Random Collaborator", "collab@corp.com", "collab"), // collaborator
        commit("Jane Doe", "jane@personal.com", "janedoe"), // owner dup (deduped)
      ],
      "janedoe",
      "janedoe/repo",
    );
    expect(res.authors.length).toBe(1);
    expect(res.authors[0].name).toBe("Jane Doe");
    expect(res.authors[0].email).toBe("jane@personal.com");
    expect(res.authors[0].attributedLogin).toBe("janedoe");
    expect(res.scanned).toBe(3);
    expect(res.excluded).toBe(1);
    expect(res.authors.length).toBe(res.scanned - res.excluded - 1 /* deduped owner */);
  });

  test("collaborator identities are NOT attributed to the subject", () => {
    const res = selectOwnerCommits(
      [
        commit("Collaborator One", "one@corp.com", "one"),
        commit("Collaborator Two", "two@corp.com", "two"),
      ],
      "janedoe",
      "janedoe/repo",
    );
    expect(res.authors).toEqual([]);
    expect(res.excluded).toBe(2);
    expect(res.scanned).toBe(2);
  });

  test("commits with no resolvable GitHub author (null) are excluded", () => {
    const res = selectOwnerCommits(
      [commit("Unlinked Author", "ghost@nowhere.com", null)],
      "janedoe",
      "janedoe/repo",
    );
    expect(res.authors).toEqual([]);
    expect(res.excluded).toBe(1);
  });

  test("bot commits are excluded even if author login somehow matches", () => {
    const res = selectOwnerCommits(
      [commit("dependabot[bot]", "support@github.com", "janedoe")],
      "janedoe",
      "janedoe/repo",
    );
    expect(res.authors).toEqual([]);
    expect(res.excluded).toBe(1);
  });

  test("noreply emails are blanked but the name identity is still recorded", () => {
    const res = selectOwnerCommits(
      [commit("Jane Doe", "12345+janedoe@users.noreply.github.com", "janedoe")],
      "janedoe",
      "janedoe/repo",
    );
    expect(res.authors.length).toBe(1);
    expect(res.authors[0].email).toBe(""); // contentless email blanked
    expect(res.authors[0].name).toBe("Jane Doe");
  });
});

/** Fixture: 5 logins, each with 3 repos; one identity repeats across repos so
 *  the order-sensitive `seen` dedupe is exercised. */
function fixtureDeps(): GitHubPassDeps {
  const logins = ["alpha", "bravo", "charlie", "delta", "echo"];
  const profiles: Record<string, any> = {};
  const commits: Record<string, any[]> = {};
  for (const login of logins) {
    profiles[login] = { name: `${login} name`, html_url: `https://github.com/${login}` };
    for (const r of [1, 2, 3]) {
      commits[`${login}/repo${r}`] = [
        commit(`${login} real`, `${login}@mail.com`, login, `2024-0${r}-01T00:00:00Z`),
        commit(`${login} r${r}`, `${login}${r}@mail.com`, login),
        commit("Collab", "c@corp.com", "collab"),
      ];
    }
  }
  return buildGitHubDepsFromFixture(profiles, commits);
}

/** Wrap a ghGet with random delays (and optional per-URL overrides) while
 *  tracking peak in-flight requests and every URL requested. */
function instrument(
  base: GitHubPassDeps,
  opts: { delay?: (url: string) => number; override?: (url: string) => { status: number; json: any } | null | undefined } = {},
) {
  const stats = { inFlight: 0, peak: 0, urls: [] as string[] };
  const deps: GitHubPassDeps = {
    ghGet: async (url) => {
      stats.urls.push(url);
      stats.inFlight++;
      stats.peak = Math.max(stats.peak, stats.inFlight);
      await Bun.sleep(opts.delay ? opts.delay(url) : Math.random() * 8);
      stats.inFlight--;
      const o = opts.override?.(url);
      return o !== undefined ? o : base.ghGet!(url);
    },
  };
  return { deps, stats };
}

const SEEDS = ["alpha", "bravo", "charlie", "delta", "echo"];

describe("runGitHubPass (bounded concurrency)", () => {
  test("random delays produce the same result as a zero-delay run, with real overlap", async () => {
    const baseline = await runGitHubPass(SEEDS, { deps: fixtureDeps() });
    expect(baseline.identities.map((i) => i.login)).toEqual(SEEDS);
    expect(baseline.identities[0].commitAuthors.map((a) => a.name)).toEqual(["alpha real", "alpha r1", "alpha r2", "alpha r3"]);
    for (let run = 0; run < 3; run++) {
      const { deps, stats } = instrument(fixtureDeps());
      const res = await runGitHubPass(SEEDS, { deps });
      expect(res).toEqual(baseline);
      expect(stats.peak).toBeGreaterThan(1);
    }
  });

  const isUser = (login: string) => (url: string) => url.endsWith(`/users/${login}`);

  test("403 stops the pass: only logins before it, rateLimited, no new requests after", async () => {
    // charlie is rate-limited instantly while alpha/bravo are still in flight.
    const { deps, stats } = instrument(fixtureDeps(), {
      delay: (url) => (isUser("charlie")(url) ? 0 : 10),
      override: (url) => (isUser("charlie")(url) ? { status: 403, json: null } : undefined),
    });
    const res = await runGitHubPass(SEEDS, { deps });
    expect(res.rateLimited).toBe(true);
    expect(res.identities.map((i) => i.login)).toEqual(["alpha", "bravo"]);
    expect(res.queried).toEqual(SEEDS);
    expect(stats.urls.some((u) => /\/(delta|echo)\b/.test(u))).toBe(false);
  });

  test("a later login finishing before the earlier 403 lands is still dropped", async () => {
    const { deps } = instrument(fixtureDeps(), {
      delay: (url) => (isUser("bravo")(url) ? 30 : 0),
      override: (url) => (isUser("bravo")(url) ? { status: 429, json: null } : undefined),
    });
    const res = await runGitHubPass(SEEDS, { deps });
    expect(res.rateLimited).toBe(true);
    expect(res.identities.map((i) => i.login)).toEqual(["alpha"]);
  });

  test("network failure (null) on a user fetch stops the pass without rateLimited", async () => {
    const { deps } = instrument(fixtureDeps(), {
      override: (url) => (isUser("delta")(url) ? null : undefined),
    });
    const res = await runGitHubPass(SEEDS, { deps });
    expect(res.rateLimited).toBe(false);
    expect(res.identities.map((i) => i.login)).toEqual(["alpha", "bravo", "charlie"]);
  });
});
