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
The misses it left were structural and are now fixed (see Accuracy).

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
3. **Open and archival sources** — only sources Firecrawl or a browser can
   read without auth; anything behind an API key or login wall is out (X and
   LinkedIn stay the existing optional passes). In order:
   a. *Probe hit → scrape*: the existence probes record profile *presence*
      on ~25 sites; scrape each hit and run the existing extractors and
      bridge detection over it (HN, npm, Mastodon, Gravatar, Keybase, …).
   b. *Archive content*: `archive-pass.ts` records Wayback capture dates
      only; read the earliest/latest captures (`id_` URLs) and add the
      Common Crawl index as a second archive. A pre-rename capture that
      mentions the audited handle is a dated bridge.
   c. *Keybase proofs*: scrape `keybase.io/<h>`, follow each proof link
      (e.g. the GitHub gist) and check it names the Keybase user; a verified
      proof is a strong owner-signed graph edge, an unverified one a lead.
   d. Add-ons: Bluesky PLC audit log (handle history), npm/PyPI package
      author emails, PGP keyserver name↔email lookups.
4. **Reddit enrichment fallback** — the `/about.json` probe 403s from
   datacenter IPs. Arctic Shift (already a dependency) may serve account
   metadata; also probe bridge owners' Reddit profiles — cake-day vs
   cake-day is rename-window evidence.

## Accuracy

Eval (14 fixtures): bridge F1 100%, fusion recall 100%, zero false links,
risk 14/14 — all pinned as ratchet floors. The fixtures are synthetic and
were written alongside the code, so these pin regressions; they do not
measure real-world accuracy.

Recently fixed: the shared matching library (`match.ts`) and its heuristic
fixes (disclosure context, bridge-confidence rename edges, `@handle`
bridges, timezone plateau, link-post URLs, findings quote/permalink
pairing, age reads only subject text, drift position matching, ranker
token boost); anchor-rename entries keyed by their link target (a third
party's page no longer becomes a bridge owner, and an anchor is never its
own reciprocal); bridge owners join the final mention pass (reciprocity in
single-round sweeps); with a graph, unowned clusters no longer count for the
subject; alt-lead sweeps no longer add bridge owners to the subject's list;
existence probes include the audited username; own-domain emails join the
site's owner; first-person residence statements corroborate a subject
location without an LLM finding.

5. **Held-out real-world fixtures** — freeze a few real runs on accounts
   the operator controls into fixtures that are never used for tuning, so
   the eval measures accuracy and not only regressions.
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
   `<details>` block; add an ETA to status output (per-phase timing is
   logged and saved as `phaseMs`).
