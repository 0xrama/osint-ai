import { describe, expect, test, mock } from "bun:test";
import { runDeterministicWebSweep, rankHandles, buildQueries, profileRootHandle, worthScraping, scoreBridgeEntry, computeReciprocal, type WebSweepDeps } from "./web-sweep.ts";
import { generateDriftVariants } from "./handle-drift.ts";
import type { SocialHandle } from "./extract.ts";

/**
 * Regression: distractor search results must not create identifiers.
 *
 * The sweep selects scrape candidates from search results (by mentionsSeed) but
 * must extract identifiers from ACTUALLY-SCRAPED pages only — never from raw
 * search snippets. A snippet from an unrelated result that happens to carry an
 * email must not become an identifier or a snowball seed.
 *
 * Uses the sweep's dependency-injection seams (WebSweepDeps) so this is fully
 * deterministic and network-free, with no global module mocking.
 */

const searchImpl: WebSweepDeps["search"] = async (query) => [
	{
		query,
		title: "janedoe on GitHub",
		url: "https://github.com/janedoe",
		description: "Reach me at distractor@evil.com — snippet only",
		markdown: undefined,
	},
	{
		query,
		title: "janedoe",
		url: "https://x.com/janedoe",
		description: "noise@noise.com handle in a search snippet",
		markdown: undefined,
	},
];

const scrapeImpl: WebSweepDeps["scrape"] = async (url) => {
	if (url.includes("github.com")) {
		return { url, title: "janedoe", description: "", markdown: "Personal site: reallead@gmail.com is my real address.", links: [] };
	}
	return { url, title: "janedoe", description: "", markdown: "no identifiers on this page", links: [] };
};

const redditAboutImpl: WebSweepDeps["redditAbout"] = async () => null;

const deps: WebSweepDeps = { search: searchImpl, scrape: scrapeImpl, redditAbout: redditAboutImpl };

describe("web-sweep scoping: snippets never feed extraction", () => {
	test("a snippet-only email is NOT extracted; a scraped-page email IS", async () => {
		const result = await runDeterministicWebSweep("janedoe", () => {}, { maxScrapes: 6, maxRounds: 2, deps });

		// The real identifier lived on a SCRAPED page → captured.
		expect(result.identifiers.emails).toContain("reallead@gmail.com");
		// These appeared ONLY in search snippets → must never become identifiers.
		expect(result.identifiers.emails).not.toContain("distractor@evil.com");
		expect(result.identifiers.emails).not.toContain("noise@noise.com");
		// And must never become snowball seeds.
		expect(result.snowballSeeds ?? []).not.toContain("distractor@evil.com");
		expect(result.snowballSeeds ?? []).not.toContain("noise@noise.com");
	});

	test("the scrape seam is actually exercised (pages read, not just indexed)", async () => {
		const scrape = mock(scrapeImpl);
		const search = mock(searchImpl);
		await runDeterministicWebSweep("janedoe", () => {}, { maxScrapes: 6, maxRounds: 2, deps: { search, scrape, redditAbout: redditAboutImpl } });
		expect(scrape).toHaveBeenCalled();
		expect(search).toHaveBeenCalled();
	});
});

/**
 * Anchor-rename bridges: a markdown link whose VISIBLE LABEL is one known
 * handle but whose TARGET is a DIFFERENT profile root — the signature of a
 * renamed handle (fixtureveil's old badge pointing at fixturenew). Stronger than a
 * text mention because the direction is unambiguous.
 */
describe("web-sweep anchor-rename bridges", () => {
	const anchorSearch: WebSweepDeps["search"] = async (query) => [
		{
			query,
			title: "fixturenew (formerly fixtureveil)",
			url: "https://github.com/fixturenew",
			description: "fixtureveil's current github",
			markdown: undefined,
		},
	];

	test("[old](new) link on a page owned by the NEW handle → anchor-rename bridge", async () => {
		const scrape: WebSweepDeps["scrape"] = async (url) => ({
			url,
			title: "fixturenew",
			description: "",
			markdown: "my old badge: [fixtureveil](https://x.com/fixturenew)",
			links: [],
		});
		const result = await runDeterministicWebSweep("fixtureveil", () => {}, {
			maxScrapes: 6,
			maxRounds: 2,
			deps: { search: anchorSearch, scrape, redditAbout: async () => null },
		});

		const entries = result.bridgeEvidence?.["fixturenew"] ?? [];
		const anchor = entries.find((e) => e.kind === "anchor-rename");
		expect(anchor).toBeDefined();
		expect(anchor?.target).toBe("fixtureveil");
		expect(anchor?.anchorTarget).toBe("fixturenew");
		// The rename target becomes a highest-priority bridge-owner seed.
		expect(result.bridgeOwnerHandles).toContain("fixturenew");
	});

	test("label == target self-link is NOT an anchor-rename bridge", async () => {
		const scrape: WebSweepDeps["scrape"] = async (url) => ({
			url,
			title: "fixtureveil",
			description: "",
			markdown: "follow me: [fixtureveil](https://x.com/fixtureveil)",
			links: [],
		});
		const search: WebSweepDeps["search"] = async (query) => [
			{
				query,
				title: "fixtureveil on X",
				url: "https://x.com/fixtureveil",
				description: "fixtureveil's twitter",
				markdown: undefined,
			},
		];
		const result = await runDeterministicWebSweep("fixtureveil", () => {}, {
			maxScrapes: 6,
			maxRounds: 2,
			deps: { search, scrape, redditAbout: async () => null },
		});

		const all = Object.values(result.bridgeEvidence ?? {}).flat();
		expect(all.filter((e) => e.kind === "anchor-rename")).toEqual([]);
	});
});

/**
 * Drift-aware clustering (rankHandles): digit/letter confusable spellings
 * (fixtureveil on GitHub vs fixtureve1l on X) are the SAME person and must
 * merge into one cross-platform cluster, guarded against short-handle
 * collisions (bo0 vs bool).
 */
describe("web-sweep drift-aware clustering (rankHandles)", () => {
	const h = (platform: string, handle: string): SocialHandle => ({
		platform,
		handle,
		url: `https://${platform === "x" ? "x.com" : "github.com"}/${handle}`,
	});

	test("github fixtureveil + x fixtureve1l merge into ONE cross-platform cluster", () => {
		const ranked = rankHandles([h("github", "fixtureveil"), h("x", "fixtureve1l")], "someuser");
		expect(ranked.length).toBe(1);
		const r = ranked[0];
		expect(r.platformCount).toBe(2);
		expect(r.tier).toBe("cross-platform cluster");
		expect(r.platforms.sort()).toEqual(["github", "x"]);
		expect(r.variants).toContain("fixtureveil");
		expect(r.variants).toContain("fixtureve1l");
		expect(r.driftVariants).toBeDefined();
	});

	test("identical spelling across platforms still clusters (no drift needed)", () => {
		const ranked = rankHandles([h("github", "fixtureveil"), h("x", "fixtureveil")], "someuser");
		expect(ranked.length).toBe(1);
		expect(ranked[0].platformCount).toBe(2);
		expect(ranked[0].tier).toBe("cross-platform cluster");
	});

	test("short keys (< 5 chars) do NOT drift-merge: bool vs bo0 stay separate", () => {
		const ranked = rankHandles([h("github", "bool"), h("x", "bo0")], "someuser");
		expect(ranked.length).toBe(2);
		expect(ranked.every((r) => r.tier === "single platform")).toBe(true);
	});

	test("separator variants of a drift spelling merge with the whole family", () => {
		const ranked = rankHandles(
			[h("github", "fixture.veil"), h("x", "fixtureve1l"), h("instagram", "fixture_veil")],
			"someuser",
		);
		expect(ranked.length).toBe(1);
		expect(ranked[0].platformCount).toBe(3);
		expect(ranked[0].variants).toContain("fixture.veil");
		expect(ranked[0].variants).toContain("fixtureve1l");
	});
});

/**
 * Drift-variant snowball seeds: round 2 deterministically queries drifted
 * spellings of top-tier handles (bridge owners first), with full seed hygiene
 * (reserved words, short handles, and the audited username never fire).
 */
describe("web-sweep drift-variant search seeds", () => {
	// Bridge-owner fixture: github.com/fixturenew is scraped and mentions the
	// audited username → fixturenew becomes a bridge-owner seed.
	const bridgeOwnerSearch: WebSweepDeps["search"] = async (query) => [
		{
			query,
			title: "fixturenew (formerly fixtureveil)",
			url: "https://github.com/fixturenew",
			description: "fixtureveil's current github",
			markdown: undefined,
		},
	];
	const bridgeOwnerScrape: WebSweepDeps["scrape"] = async (url) => ({
		url,
		title: "fixturenew",
		description: "",
		markdown: "Hi, I am fixturenew. Old friends remember when fixtureveil was my name.",
		links: [],
	});

	test("a bridge-owner discovery triggers round-2 queries for its drift variants", async () => {
		const result = await runDeterministicWebSweep("fixtureveil", () => {}, {
			maxScrapes: 6,
			maxRounds: 2,
			deps: { search: bridgeOwnerSearch, scrape: bridgeOwnerScrape, redditAbout: async () => null },
		});
		// The first 4 non-exact drift variants of the bridge owner should have
		// been queried (bounded, deterministic order).
		const expected = generateDriftVariants("fixturenew").filter((v) => v !== "fixturenew").slice(0, 4);
		expect(expected.length).toBeGreaterThan(0);
		expect(result.queries.some((q) => expected.some((v) => q.includes(`"${v}"`)))).toBe(true);
		// And the trail is recorded in snowballSeeds.
		expect(result.snowballSeeds?.some((s) => expected.includes(s))).toBe(true);
	});

	test("short bridge-owner handles fire NO drift queries (all variants < 4 chars)", async () => {
		const search: WebSweepDeps["search"] = async (query) => [
			{
				query,
				title: "xyz (formerly fixtureveil)",
				url: "https://github.com/xyz",
				description: "fixtureveil's current github",
				markdown: undefined,
			},
		];
		const scrape: WebSweepDeps["scrape"] = async (url) => ({
			url,
			title: "xyz",
			description: "",
			markdown: "Hi, I am xyz. Old friends remember when fixtureveil was my name.",
			links: [],
		});
		const result = await runDeterministicWebSweep("fixtureveil", () => {}, {
			maxScrapes: 6,
			maxRounds: 2,
			deps: { search, scrape, redditAbout: async () => null },
		});
		// Every drift variant of a 3-char handle is itself 3 chars — all filtered.
		expect(result.queries.filter((q) => /"[a-z]*[0-9][a-z0-9]*"/.test(q) && !q.includes("fixture"))).toEqual([]);
	});

	test("hygiene: drift seeds are never reserved words nor the audited username", async () => {
		const result = await runDeterministicWebSweep("fixtureveil", () => {}, {
			maxScrapes: 6,
			maxRounds: 2,
			deps: { search: bridgeOwnerSearch, scrape: bridgeOwnerScrape, redditAbout: async () => null },
		});
		const reserved = ["github", "download", "trending", "trending_repos", "login", "explore"];
		for (const seed of result.snowballSeeds ?? []) {
			expect(seed.toLowerCase()).not.toBe("fixtureveil");
			expect(reserved).not.toContain(seed.toLowerCase());
		}
	});
});

/**
 * Platform battery alignment: the extractor (extract.ts SOCIAL_PATTERNS)
 * recognizes 12 platforms — the sweep's query battery and profile-root parser
 * must cover the same set, otherwise an extractable platform is never searched
 * (a site:gitlab.com hit can't fire) or its profile URL is never scraped
 * (youtube.com/@user stays unvisited). These tests pin that alignment.
 */
describe("web-sweep platform battery alignment", () => {
	test("buildQueries targets the extractor's platform set", () => {
		const queries = buildQueries("fixtureveil");
		expect(queries).toContain('site:github.com "fixtureveil"');
		expect(queries).toContain('site:youtube.com "fixtureveil"');
		expect(queries).toContain('site:gitlab.com "fixtureveil"');
		expect(queries).toContain('site:bsky.app "fixtureveil"');
		expect(queries).toContain('site:news.ycombinator.com "fixtureveil"');
		// The bare-platform query carries the new platforms too.
		expect(queries).toContain("fixtureveil github OR youtube OR gitlab OR bluesky");
	});

	test("profileRootHandle parses the new platform profile roots", () => {
		expect(profileRootHandle("https://www.youtube.com/@somehandle")).toBe("somehandle");
		expect(profileRootHandle("https://youtube.com/channel/UCxyz123")).toBe("UCxyz123");
		expect(profileRootHandle("https://www.youtube.com/c/channelname")).toBe("channelname");
		expect(profileRootHandle("https://www.youtube.com/user/oldname")).toBe("oldname");
		expect(profileRootHandle("https://gitlab.com/userone")).toBe("userone");
		expect(profileRootHandle("https://bsky.app/profile/handle.bsky.social")).toBe("handle.bsky.social");
		expect(profileRootHandle("https://bsky.app/profile/did:plc:abc123")).toBe("did:plc:abc123");
		expect(profileRootHandle("https://news.ycombinator.com/user?id=somehandle")).toBe("somehandle");
		expect(profileRootHandle("https://stackoverflow.com/users/123/john")).toBe("123");
		expect(profileRootHandle("https://stackoverflow.com/users/123")).toBe("123");
		expect(profileRootHandle("https://mastodon.social/@somehandle")).toBe("somehandle");
	});

	test("profileRootHandle rejects platform plumbing paths", () => {
		expect(profileRootHandle("https://youtube.com/watch?v=x")).toBeNull();
		expect(profileRootHandle("https://youtube.com/@somehandle/videos")).toBeNull();
		expect(profileRootHandle("https://youtube.com/results?search_query=x")).toBeNull();
		expect(profileRootHandle("https://gitlab.com/explore")).toBeNull();
		expect(profileRootHandle("https://stackoverflow.com/questions/1/some-question")).toBeNull();
		expect(profileRootHandle("https://bsky.app/profile")).toBeNull();
	});

	test("worthScraping accepts the new profile roots and rejects plumbing", () => {
		expect(worthScraping("https://www.youtube.com/@somehandle")).toBe(true);
		expect(worthScraping("https://gitlab.com/userone")).toBe(true);
		expect(worthScraping("https://bsky.app/profile/handle.bsky.social")).toBe(true);
		expect(worthScraping("https://news.ycombinator.com/user?id=somehandle")).toBe(true);
		expect(worthScraping("https://stackoverflow.com/users/123/john")).toBe(true);
		expect(worthScraping("https://mastodon.social/@somehandle")).toBe(true);
		expect(worthScraping("https://gitlab.com/explore")).toBe(false);
		expect(worthScraping("https://youtube.com/watch?v=x")).toBe(false);
		expect(worthScraping("https://stackoverflow.com/questions/1/some-question")).toBe(false);
	});
});

/**
 * Bridge confidence + reciprocity (ROADMAP #3): not all bridges weigh the
 * same. scoreBridgeEntry assigns a deterministic 0..1 strength per evidence
 * entry (anchor-rename 1.0 > own aggregator 0.9 > own profile 0.8 >
 * third-party 0.5, +0.2 reciprocal capped at 1.0); computeReciprocal finds
 * two-way mention edges (A↔B) — a far stronger same-person signal than a
 * one-way mention.
 */
describe("web-sweep bridge confidence scoring (scoreBridgeEntry)", () => {
	test("anchor-rename is 1.0; aggregator 0.9; big-platform profile 0.8; third-party 0.5", () => {
		expect(scoreBridgeEntry({ kind: "anchor-rename" }, "https://someblog.example/post")).toBe(1);
		expect(scoreBridgeEntry({}, "https://linktr.ee/fixturenew")).toBe(0.9);
		expect(scoreBridgeEntry({}, "https://github.com/fixturenew")).toBe(0.8);
		expect(scoreBridgeEntry({}, "https://www.github.com/fixturenew")).toBe(0.8);
		expect(scoreBridgeEntry({}, "https://randomblog.example/article")).toBe(0.5);
	});

	test("reciprocity adds +0.2 and caps at 1.0", () => {
		expect(scoreBridgeEntry({}, "https://github.com/fixturenew", true)).toBe(1);
		expect(scoreBridgeEntry({}, "https://randomblog.example/article", true)).toBe(0.7);
		expect(scoreBridgeEntry({ kind: "anchor-rename" }, "https://x.com/fixturenew", true)).toBe(1);
	});
});

describe("web-sweep reciprocity detection (computeReciprocal)", () => {
	test("a plain two-way mention pair is detected in both directions", () => {
		const rec = computeReciprocal({
			handlea: [{ url: "https://github.com/handlea", snippet: "…", target: "handleb" }],
			handleb: [{ url: "https://x.com/handleb", snippet: "…", target: "handlea" }],
		});
		expect(rec.has("handlea->handleb")).toBe(true);
		expect(rec.has("handleb->handlea")).toBe(true);
	});

	test("anchor-rename form: the rename pair (target ↔ anchorTarget) counts as the reverse edge", () => {
		// Owner's page carries [old](new) — the label literally points back at
		// the new profile, so the pair is reciprocal by construction.
		const rec = computeReciprocal({
			fixturenew: [{ url: "https://github.com/fixturenew", snippet: "…", target: "fixtureveil", kind: "anchor-rename", anchorTarget: "fixturenew" }],
		});
		expect(rec.has("fixturenew->fixtureveil")).toBe(true);
	});

	test("a one-way edge is NOT reciprocal", () => {
		const rec = computeReciprocal({
			handlea: [{ url: "https://github.com/handlea", snippet: "…", target: "handleb" }],
		});
		expect(rec.size).toBe(0);
	});
});

describe("web-sweep bridge confidence in rankHandles", () => {
	const h = (platform: string, handle: string): SocialHandle => ({
		platform,
		handle,
		url: `https://${platform === "x" ? "x.com" : "github.com"}/${handle}`,
	});

	test("bridge tier sorts by bridgeConfidence desc and carries the field", () => {
		const ranked = rankHandles(
			[h("github", "carol"), h("x", "dave")],
			"auditeduser",
			{
				dave: [{ url: "https://randomblog.example/post", snippet: "…", target: "auditeduser" }],
				carol: [{ url: "https://github.com/carol", snippet: "…", target: "auditeduser", kind: "anchor-rename", anchorTarget: "carol" }],
			},
		);
		expect(ranked.every((r) => r.tier === "bridge")).toBe(true);
		expect(ranked[0].handle).toBe("carol");
		expect(ranked[0].bridgeConfidence).toBe(1);
		expect(ranked[1].handle).toBe("dave");
		expect(ranked[1].bridgeConfidence).toBe(0.5);
	});
});

describe("web-sweep enrichment: every exported bridge entry carries confidence/reciprocal", () => {
	// Two pages owned by different handles mentioning each other: github.com/betahandle
	// (clustered on 2 platforms so it snowballs into the final known-handle set)
	// mentions the audited username, and x.com/alphauser mentions betahandle →
	// a reciprocal pair, both edges at the 1.0 cap (0.8 own-profile + 0.2).
	const search: WebSweepDeps["search"] = async (query) => [
		{
			query,
			title: "betahandle (formerly alphauser)",
			url: "https://github.com/betahandle",
			description: "alphauser's current github",
			markdown: undefined,
		},
		{
			query,
			title: "alphauser",
			url: "https://x.com/alphauser",
			description: "alphauser on x",
			markdown: undefined,
		},
	];
	const scrape: WebSweepDeps["scrape"] = async (url) => {
		if (url.includes("github.com")) {
			return {
				url,
				title: "betahandle",
				description: "",
				markdown: "Hi, I am betahandle — previously alphauser. Also on https://x.com/betahandle and https://instagram.com/betahandle",
				links: [],
			};
		}
		return {
			url,
			title: "alphauser",
			description: "",
			markdown: "old account alphauser here; find me now as betahandle everywhere",
			links: [],
		};
	};

	test("two faked pages mentioning each other → both entries reciprocal, confidence capped", async () => {
		const result = await runDeterministicWebSweep("alphauser", () => {}, {
			maxScrapes: 6,
			maxRounds: 2,
			deps: { search, scrape, redditAbout: async () => null },
		});

		const ownerSide = result.bridgeEvidence?.["betahandle"] ?? [];
		expect(ownerSide.length).toBeGreaterThan(0);
		for (const e of ownerSide) {
			expect(e.reciprocal).toBe(true);
			expect(e.confidence).toBe(1);
		}

		const auditedSide = result.bridgeEvidence?.["alphauser"] ?? [];
		expect(auditedSide.length).toBeGreaterThan(0);
		for (const e of auditedSide) {
			expect(e.reciprocal).toBe(true);
			expect(e.confidence).toBe(1);
		}

		// Every exported entry everywhere carries the fields.
		for (const entries of Object.values(result.bridgeEvidence ?? {})) {
			for (const e of entries) {
				expect(typeof e.confidence).toBe("number");
				expect(typeof e.reciprocal).toBe("boolean");
			}
		}
	});
});
