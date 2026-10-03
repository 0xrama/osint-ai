import { describe, expect, test } from "bun:test";
import {
  renderExistenceProbeBlock,
  renderExistenceProbeContextForPrompt,
  runExistenceProbes,
} from "./existence-probe.ts";

/**
 * Fake fetchText routing by exact URL. Unrouted URLs 404 (absent) so tests
 * stay deterministic; Error values simulate a network/parse failure.
 */
function fakeFetch(routes: Record<string, { status: number; body?: string } | Error>) {
  return async (url: string): Promise<{ status: number; body: string }> => {
    const route = routes[url];
    if (route === undefined) return { status: 404, body: "" };
    if (route instanceof Error) throw route;
    return { status: route.status, body: route.body ?? "" };
  };
}

describe("runExistenceProbes (classification)", () => {
  test("200 + presence marker hit → exists; 404 → absent; 302 redirect → unknown", async () => {
    const deps = {
      fetchText: fakeFetch({
        "https://t.me/fixtureone": { status: 200, body: "<html>If you have Telegram, you can contact @fixtureone.</html>" },
        "https://gitlab.com/fixtureone": { status: 404 },
        "https://www.twitch.tv/fixtureone": { status: 302 },
      }),
    };
    const res = await runExistenceProbes(["fixtureone"], { deps });
    const byPlatform = Object.fromEntries(res.probes.map((p) => [p.platform, p]));
    expect(byPlatform.telegram.outcome).toBe("exists");
    expect(byPlatform.telegram.httpStatus).toBe(200);
    expect(byPlatform.gitlab.outcome).toBe("absent");
    expect(byPlatform.gitlab.httpStatus).toBe(404);
    // Redirects (login walls etc.) must never read as existence.
    expect(byPlatform.twitch.outcome).toBe("unknown");
  });

  test("200 + presence marker miss → unknown (conservative, no false absent)", async () => {
    const deps = {
      fetchText: fakeFetch({
        "https://t.me/fixtureone": { status: 200, body: "<html>some other page layout</html>" },
      }),
    };
    const res = await runExistenceProbes(["fixtureone"], { deps });
    expect(res.probes.find((p) => p.platform === "telegram")?.outcome).toBe("unknown");
  });

  test("absence-marker sites: 200 + not-found text → absent; 200 without → exists", async () => {
    const deps = {
      fetchText: fakeFetch({
        "https://steamcommunity.com/id/fixturegone": { status: 200, body: "The specified profile could not be found." },
        "https://news.ycombinator.com/user?id=fixtureone": { status: 200, body: "user: fixtureone created 5 years ago" },
      }),
    };
    const res = await runExistenceProbes(["fixturegone", "fixtureone"], { maxHandles: 2, deps });
    expect(res.probes.find((p) => p.platform === "steam" && p.handle === "fixturegone")?.outcome).toBe("absent");
    expect(res.probes.find((p) => p.platform === "hackernews" && p.handle === "fixtureone")?.outcome).toBe("exists");
  });

  test("per-probe fetch error is swallowed → unknown with httpStatus 0", async () => {
    const deps = {
      fetchText: fakeFetch({
        "https://dev.to/fixtureone": new Error("ECONNRESET"),
      }),
    };
    const res = await runExistenceProbes(["fixtureone"], { deps });
    const devto = res.probes.find((p) => p.platform === "dev.to");
    expect(devto?.outcome).toBe("unknown");
    expect(devto?.httpStatus).toBe(0);
    // The rest of the pass still ran.
    expect(res.probes.length).toBeGreaterThan(1);
  });

  test("plain status site: 200 → exists (no marker needed)", async () => {
    const deps = {
      fetchText: fakeFetch({
        "https://gitlab.com/fixtureone": { status: 200, body: "whatever" },
      }),
    };
    const res = await runExistenceProbes(["fixtureone"], { deps });
    expect(res.probes.find((p) => p.platform === "gitlab")?.outcome).toBe("exists");
  });
});

describe("runExistenceProbes (scoping & determinism)", () => {
  test("maxHandles caps how many handles are probed", async () => {
    const deps = { fetchText: fakeFetch({}) };
    const res = await runExistenceProbes(["h_one", "h_two", "h_three", "h_four"], { maxHandles: 2, deps });
    const probed = new Set(res.probes.map((p) => p.handle));
    expect([...probed].sort()).toEqual(["h_one", "h_two"]);
  });

  test("handles are deduped case-insensitively and @-stripped", async () => {
    const deps = { fetchText: fakeFetch({}) };
    const res = await runExistenceProbes(["FixtureOne", "@fixtureone", "FIXTUREONE"], { deps });
    expect(new Set(res.probes.map((p) => p.handle))).toEqual(new Set(["FixtureOne"]));
  });

  test("empty handles → empty result", async () => {
    const res = await runExistenceProbes([], { deps: { fetchText: fakeFetch({}) } });
    expect(res.probes).toEqual([]);
    expect(renderExistenceProbeBlock(res)).toBe("");
    expect(renderExistenceProbeContextForPrompt(res)).toBe("");
  });

  test("ordering is deterministic (handle order × table order)", async () => {
    const deps = { fetchText: fakeFetch({}) };
    const a = await runExistenceProbes(["h_one", "h_two"], { deps });
    const b = await runExistenceProbes(["h_one", "h_two"], { deps });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Handle-major ordering: every h_one probe precedes every h_two probe.
    expect(a.probes.length).toBe(b.probes.length);
    expect(a.probes.map((p) => p.handle).lastIndexOf("h_one")).toBe(a.probes.length / 2 - 1);
    expect(a.probes.slice(0, a.probes.length / 2).every((p) => p.handle === "h_one")).toBe(true);
  });
});

describe("renderers", () => {
  const deps = {
    fetchText: fakeFetch({
      "https://t.me/fixtureone": { status: 200, body: "If you have Telegram, you can contact." },
      "https://gitlab.com/fixtureone": { status: 404 },
      "https://www.twitch.tv/fixtureone": { status: 302 },
    }),
  };

  test("block lists EXISTS rows first, then absent/unknown rollup", async () => {
    const res = await runExistenceProbes(["fixtureone"], { deps });
    const block = renderExistenceProbeBlock(res);
    const existsRow = block.indexOf("| telegram | fixtureone | exists |");
    const rollup = block.indexOf("absent /");
    expect(existsRow).toBeGreaterThanOrEqual(0);
    expect(rollup).toBeGreaterThan(existsRow);
    expect(block).toContain("## Username Existence Probes");
    // Absent/unknown rows are NOT in the table.
    expect(block).not.toContain("| absent |");
    expect(block).not.toContain("| unknown |");
  });

  test("prompt context lists only EXISTS hits with lead framing", async () => {
    const res = await runExistenceProbes(["fixtureone"], { deps });
    const ctx = renderExistenceProbeContextForPrompt(res);
    expect(ctx).toContain("https://t.me/fixtureone");
    expect(ctx).toContain("same-person unverified");
    expect(ctx).not.toContain("gitlab.com/fixtureone");
    expect(ctx).not.toContain("twitch.tv/fixtureone");
  });
});
