import { describe, expect, test } from "bun:test";
import { selectOwnerCommits } from "./github-pass.ts";

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
