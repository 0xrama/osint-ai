import { describe, expect, test } from "bun:test";
import {
  renderArchiveBlock,
  renderArchiveContextForPrompt,
  runArchivePass,
} from "./archive-pass.ts";

/** Realistic CDX responses, one per pattern query (as the real API returns). */
const CDX_HEADER = ["url", "timestamp", "original", "mimetype", "statuscode", "digest", "length"];
const CDX_TWITTER = [
  CDX_HEADER,
  ["twitter.com/fixtureone/", "20190401120000", "https://twitter.com/fixtureone", "text/html", "200", "aaa", "1000"],
  ["twitter.com/fixtureone/", "20210603040000", "https://twitter.com/fixtureone", "text/html", "200", "bbb", "1000"],
  ["twitter.com/fixtureone/", "20220101000000", "https://twitter.com/fixtureone", "text/html", "404", "ccc", "500"],
];
const CDX_GITHUB = [
  CDX_HEADER,
  ["github.com/fixtureone", "20200505000000", "https://github.com/fixtureone", "text/html", "200", "ddd", "800"],
];

function fakeFetchJson(jsonFor: (url: string) => any) {
  return async (url: string): Promise<any> => jsonFor(url);
}

/** Route by the CDX `url=` query param so each pattern query gets only its
 *  own rows (like the real API) — a blanket canned response would merge the
 *  same rows once per pattern and inflate counts. */
function cdxRoute(byPattern: Record<string, any>, fallback: any = []) {
  return fakeFetchJson((url: string) => {
    const pattern = decodeURIComponent(url.split("url=")[1] ?? "").split("&")[0];
    return byPattern[pattern] ?? fallback;
  });
}

describe("runArchivePass (parsing)", () => {
  test("dedupes by URL, drops non-200 captures, computes first/last/count", async () => {
    const deps = {
      fetchJson: cdxRoute({
        "twitter.com/fixtureone": CDX_TWITTER,
        "github.com/fixtureone": CDX_GITHUB,
      }),
    };
    const res = await runArchivePass(["fixtureone"], { deps });
    expect(res.snapshots.length).toBe(2);
    const twitter = res.snapshots.find((s) => s.url === "twitter.com/fixtureone/");
    expect(twitter?.firstSnapshot).toBe("20190401120000");
    expect(twitter?.lastSnapshot).toBe("20210603040000");
    expect(twitter?.count).toBe(2); // the 404-status capture is dropped
    const github = res.snapshots.find((s) => s.url === "github.com/fixtureone");
    expect(github?.count).toBe(1);
  });

  test("empty CDX response ([]) → no snapshots", async () => {
    const res = await runArchivePass(["fixtureone"], { deps: { fetchJson: fakeFetchJson(() => []) } });
    expect(res.snapshots).toEqual([]);
  });

  test("erroring fetch is swallowed per query (no throw, partial results ok)", async () => {
    const deps = {
      fetchJson: async (url: string) => {
        if (url.includes("github.com")) throw new Error("wayback flaked");
        return cdxRoute({ "twitter.com/fixtureone": CDX_TWITTER })(url);
      },
    };
    const res = await runArchivePass(["fixtureone"], { deps });
    // github queries errored and contributed nothing; twitter rows survived.
    expect(res.snapshots.some((s) => s.url === "twitter.com/fixtureone/")).toBe(true);
    expect(res.snapshots.some((s) => s.url === "github.com/fixtureone")).toBe(false);
  });

  test("every-erroring fetch → empty result, never a throw", async () => {
    const res = await runArchivePass(
      ["fixtureone"],
      { deps: { fetchJson: async () => { throw new Error("down"); } } },
    );
    expect(res.snapshots).toEqual([]);
  });

  test("maxHandles caps handle count; handles deduped case-insensitively", async () => {
    let queried = 0;
    const res = await runArchivePass(
      ["h_one", "@h_one", "h_two", "h_three"],
      {
        maxHandles: 2,
        deps: {
          fetchJson: async () => {
            queried++;
            return [];
          },
        },
      },
    );
    expect(res.snapshots).toEqual([]);
    expect(queried).toBe(2 * 5); // 2 handles × 5 patterns
  });
});

describe("renderers", () => {
  const CAKE_DAY_2020 = Math.floor(Date.UTC(2020, 0, 1) / 1000);

  test("pre-cake-day annotation appears when subjectCreatedUtc is given", async () => {
    const res = await runArchivePass(
      ["fixtureone"],
      {
        subjectCreatedUtc: CAKE_DAY_2020,
        deps: { fetchJson: cdxRoute({ "twitter.com/fixtureone": CDX_TWITTER, "github.com/fixtureone": CDX_GITHUB }) },
      },
    );
    const block = renderArchiveBlock(res, CAKE_DAY_2020);
    // twitter first capture 2019-04-01 predates the 2020-01-01 cake day.
    expect(block).toContain("twitter.com/fixtureone/");
    const twitterLine = block.split("\n").find((l) => l.includes("twitter.com/fixtureone/"));
    expect(twitterLine).toBeDefined();
    const flagLineIdx = block.indexOf("BEFORE the subject's Reddit account");
    expect(flagLineIdx).toBeGreaterThan(block.indexOf("twitter.com/fixtureone/"));
    // github first capture 2020-05-05 does NOT predate → no second flag.
    expect(block.split("\n").filter((l) => l.includes("BEFORE the subject's Reddit account")).length).toBe(1);
    expect(block).toContain("## Web Archive Pass");
    expect(block).toContain("LEAD, not evidence");
  });

  test("prompt context includes pre-cake-day flag and lead framing", async () => {
    const res = await runArchivePass(
      ["fixtureone"],
      {
        subjectCreatedUtc: CAKE_DAY_2020,
        deps: { fetchJson: cdxRoute({ "twitter.com/fixtureone": CDX_TWITTER }) },
      },
    );
    const ctx = renderArchiveContextForPrompt(res, CAKE_DAY_2020);
    expect(ctx).toContain("archived snapshots of twitter.com/fixtureone/");
    expect(ctx).toContain("PREDATES the subject's Reddit account");
    expect(ctx).toContain("rename/reclaim");
    expect(ctx).toContain("2019-04-01");
    expect(ctx).toContain("2021-06-03");
    expect(ctx).toContain("2 capture(s)");
  });

  test("renderers are non-empty only with data", async () => {
    const empty = await runArchivePass(["fixtureone"], { deps: { fetchJson: fakeFetchJson(() => []) } });
    expect(renderArchiveBlock(empty)).toBe("");
    expect(renderArchiveBlock(empty, CAKE_DAY_2020)).toBe("");
    expect(renderArchiveContextForPrompt(empty)).toBe("");
    expect(renderArchiveContextForPrompt(empty, CAKE_DAY_2020)).toBe("");
  });
});
