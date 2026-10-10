# ROADMAP

Prioritized next work on osint-ai. Each item names the failure mode it kills.
Done items are removed — git history and AGENTS.md's concept definitions carry
the past.

Implemented most recently: person-aware corroboration (namesake clusters do
not affect the subject's score/verdict; contradictions stay within a person)
and the graph-backed email local-part confidence bonus (+1, no extra source),
structured account verification labels (constrain-only), and document-level
source deduplication via canonical URLs.

Also implemented: a deterministic `--subject-name` consistency check
(CONSISTENT / INCONCLUSIVE / CONFLICTING) over subject-owned name clusters,
including attributed GitHub commit names. Read-only: never changes the score.

Also implemented: the eval fusion metric — per-fixture fusion recall (true
identifiers linked into the subject person), false fusion links, and risk
accuracy vs `expectedRisk`, pinned as ratchet floors in `eval.test.ts`. A grid
over `calibrateConfidence`'s constants found nothing above the current 7/12
risk hits: every loosening that lifts a real subject also lifts a namesake.
The remaining misses are structural (items below), not calibration.

Previously landed (context if picking up mid-stream): the person-level
identity graph (`identity-graph.ts`, incl. the email local-part join),
reciprocal bridges with deterministic confidence scoring, sub-agent
ground-truth injection (leads digest), sweep battery/scraper alignment with
the 12-platform extractor, username-existence probes + the Wayback CDX pass,
and the deterministic age estimate.

## LLM-boundary triangulation

1. **Leads as tools** — let the synthesis agent's *native* scraper act on
   bridge URLs directly. A zero-arg app tool that returns the bridge list
   already in the prompt does not count (tried and removed): it adds a
   ReAct loop to the MCP path and gives the model nothing new.

## Coverage (deterministic layers, sweep philosophy)

2. **Phrase-seed queries** — quoted rare n-grams from the subject's Reddit
   history to find cross-posts under other handles: stylometry made
   deterministic.
3. **More API passes** — the `github-pass.ts` pattern is proven; extend to
   HN (Algolia, no auth), Bluesky, Mastodon, Keybase (a literal public
   cross-platform proof graph), Gravatar (email → profile). Port the
   reference project's multi-source ingestion (Stack Overflow) the same way.
   The existence probes cover profile *presence* on ~25 sites; these passes
   add profile *content*.
4. **Reddit enrichment fallback** — the `/about.json` probe 403s from
   datacenter IPs. Arctic Shift (already a dependency) may serve account
   metadata; also probe bridge owners' Reddit profiles — cake-day vs
   cake-day is rename-window evidence.

## Accuracy

Recently fixed: handle-echo names no longer count as real names; the corpus
GitHub re-probe runs before synthesis; same-username namesakes split on a
corpus contradiction; post `selftext` is scanned. Eval (14 fixtures): risk
13/14, fusion recall 93%, zero false links.

Known misses the eval shows:
- **Anchor-rename bridge owner** (`anchor-rename-1`, bridge F1 0%) — for
  `[old](https://x.com/new)` on a third-party page, `bridgeOwnerHandles`
  lists the page owner instead of the anchor target, and both entries come
  out `reciprocal: true` / 1.0 with nothing pointing back.
- **Personal-site emails don't join the owner** (`own-domain-mailbox-1`,
  fusion 0%) — the sweep knows the site's owner; the graph never links emails
  found there to it.
- **Corpus statements aren't evidence without a finding**
  (`collaborator-commit-1`) — "I live in San Francisco" in the subject's own
  posts confirms the GitHub location only if the LLM emits a finding.

From the pipeline audit (ranked by gain per effort, all verified in code):
1. **Common-word handles fuse via disclosure** — any discovered handle of 4+
   characters mentioned as a word ("Microsoft") becomes a 0.8 disclosure edge
   and Reddit sources. Require handle-shaped context (`@h`, `u/h`, a platform
   word nearby). `identity-graph.ts` disclosure loop + corroboration corpus join.
2. **Rename edges ignore bridge confidence** — every non-anchor bridge gets a
   fixed 0.7 (above the 0.6 merge line), so a one-way 0.5 third-party mention
   merges. Use the bridge's own confidence; label weak bridges "verify" in
   prompts.
3. **Timezone fit skews west for night owls** with false "high" confidence
   (zero-vs-zero ties). Report the plateau midpoint and width. `timezone.ts`.
4. **Unknown-owner clusters count for the subject** (`isSubject` undefined
   passes `!== false`). With a graph present, require `isSubject === true`.
5. **Link-post URLs are never read** — `RedditPost.url` (a post linking the
   subject's own GitHub/blog) reaches no extractor, prompt or graph.
6. **Bridge owners missing from the final mention pass** — reciprocity
   (A→B and B→A) is never detected for round-1 pages.
7. **`@handle` never matches the bridge mention regex** (the `@` is excluded
   from the leading class). Land after #2.
8. **Findings validation doesn't pair quote with permalink**, accepts
   `/r/sub`-only permalinks and skips quotes under 8 characters.
9. **Age pass reads the whole rendered report** (namesake bios, repo years)
   and degree regexes lack a leading boundary ("maybe" → B.E.).
10. **Ranker known-handle boost** — substring match against unnormalized text,
    fed every scraped handle, not just the subject's.
11. **Drift matching** misses variants in long handles (32-variant cap) and
    over-merges trailing-digit pairs (`kevinl`~`kevin1`).
12. **Existence probes skip the audited username**; alt-lead sweeps' bridge
    owners pollute the primary bridge-owner list.

6. **Timeline coherence** — renames have ordering: the new handle's GitHub/X
   account should predate the old handle's last activity (plus slack). The
   reclaimed-handle check, the age-vs-GitHub-created check, and the archive
   pass's pre-cake-day flags each cover a slice; a single coherence check
   over the join dates would tie them together.

## Measurement & UX

7. **Run-over-run leak diff** — "new identifiers since the last audit" is
   the self-doxx killer feature; blocked on the Milestone 2 provenance
   placeholders in `evidence.ts` (`contentHash`, `retrievedAt`).
8. **Report polish** — collapse the sweep's single-platform tier into a
   `<details>` block; add ETA / per-phase progress timing to status output.
