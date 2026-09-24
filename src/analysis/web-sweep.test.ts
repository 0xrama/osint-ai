import { describe, expect, test, mock } from "bun:test";
import { runDeterministicWebSweep, type WebSweepDeps } from "./web-sweep.ts";

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
