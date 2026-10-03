# ROADMAP

Prioritized next work on osint-ai. Each item names the failure mode it kills.
Done items are removed — git history and AGENTS.md's concept definitions carry
the past.

Landed most recently (context if picking up mid-stream): the person-level
identity graph (`identity-graph.ts`, incl. the email local-part join),
reciprocal bridges with deterministic confidence scoring, sub-agent
ground-truth injection (leads digest), sweep battery/scraper alignment with
the 12-platform extractor, username-existence probes + the Wayback CDX pass,
and the deterministic age estimate.

## Triangulation fusion (`corroboration.ts`)

1. **Corroboration consumes the identity graph** — the graph already fuses
   handles into person entities and splits namesakes; corroboration still
   clusters by signal value. Feed `graph.persons` in so a namesake's
   observations can never corroborate the subject's clusters, and person-level
   contradictions (this person's location vs that one's) become representable.
2. **Email local-part confidence bonus** — the graph carries the local-part
   join (`email-of` 0.6); corroboration does not yet boost an email↔handle
   pair that matches it.

## LLM-boundary triangulation

3. **Leads as tools** — fold bridge leads into the synthesis agent's *native*
   MCP toolset so it can scrape them directly instead of reasoning from the
   injected text block.
4. **Round-trip verification labels** — synthesis labels accounts
   CONFIRMED / LIKELY / POSSIBLE / REJECTED, but REJECTED namesakes still
   count fully in corroboration and CONFIRMED disclosures add no
   reddit-domain weight. Carry the labels through a structured field. Also:
   a deterministic candidate check for `--subject-name` (name-token overlap
   vs GitHub commit names and real_name clusters, employer/location overlap).

## Coverage (deterministic layers, sweep philosophy)

5. **Phrase-seed queries** — quoted rare n-grams from the subject's Reddit
   history to find cross-posts under other handles: stylometry made
   deterministic.
6. **More API passes** — the `github-pass.ts` pattern is proven; extend to
   HN (Algolia, no auth), Bluesky, Mastodon, Keybase (a literal public
   cross-platform proof graph), Gravatar (email → profile). Port the
   reference project's multi-source ingestion (Stack Overflow) the same way.
   The existence probes cover profile *presence* on ~25 sites; these passes
   add profile *content*.
7. **Reddit enrichment fallback** — the `/about.json` probe 403s from
   datacenter IPs. Arctic Shift (already a dependency) may serve account
   metadata; also probe bridge owners' Reddit profiles — cake-day vs
   cake-day is rename-window evidence.

## Accuracy

8. **Timeline coherence** — renames have ordering: the new handle's GitHub/X
   account should predate the old handle's last activity (plus slack). The
   reclaimed-handle check, the age-vs-GitHub-created check, and the archive
   pass's pre-cake-day flags each cover a slice; a single coherence check
   over the join dates would tie them together.

## Measurement & UX

9. **Eval fusion metric** — score per-fixture recall of identity *edges*
   (corpus disclosure ↔ cluster ↔ GitHub identity), not just identifier
   lists; fit `calibrateConfidence`'s constants against `expectedRisk`
   across fixtures. The suite has 12 fixtures — bump the count assertion in
   `src/eval/eval.test.ts` whenever you add one.
10. **Run-over-run leak diff** — "new identifiers since the last audit" is
    the self-doxx killer feature; blocked on the Milestone 2 provenance
    placeholders in `evidence.ts` (`contentHash`, `retrievedAt`).
11. **Report polish** — collapse the sweep's single-platform tier into a
    `<details>` block; add ETA / per-phase progress timing to status output.
