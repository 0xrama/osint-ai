# osint-ai

CLI for auditing how much identity information leaks from a Reddit account.

Built after reading ETH Zurich's [*Large-scale online deanonymization with LLMs*](https://arxiv.org/abs/2602.16800), where LLM agents linked pseudonymous Reddit / Hacker News activity to real-world identities by combining small public clues: reused handles, locations, jobs, timezones, writing habits, links, and stale profile references.

This repo turns that idea into a local CLI for security analysts and OSINT investigators. It pulls Reddit history, runs an LLM-assisted analysis, optionally checks the wider web, and writes a report with evidence and confidence levels.

Use it only for authorized investigations, privacy reviews, red-team work, journalism with an editorial basis, or your own accounts. This is not a toy for doxxing people.

## What it does

- Fetches Reddit posts/comments for a username.
- Uses archive sources first: Arctic Shift, then PullPush fallback.
- Runs either:
  - a faster live agent scan, or
  - a deeper multi-agent scan over local JSONL data.
- Extracts concrete identifiers with regex so the model cannot paraphrase them away:
  - emails
  - GitHub / LinkedIn / X / Instagram / HN / Telegram / other profile URLs
- Optionally uses Firecrawl for web search/scrape enrichment.
- Can test a candidate real-world identity with `--subject-name` instead of assuming it is true.
- Saves Markdown or JSON reports under `reports/`.

## What it does not do

- It does not bypass Reddit auth, private profiles, deleted unavailable data, or platform access controls.
- It does not guarantee an identity match. Reports should be treated as leads until manually verified.
- It does not protect you from legal/ethical misuse. That part is on the operator.

## Install

Requires [Bun](https://bun.sh/).

```bash
bun install
bun run src/index.tsx --init-env
```

Edit `.env.local`.

OpenAI-compatible backend:

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=
```

Or use the local Claude Code CLI backend:

```env
LLM_PROVIDER=claude-code
CLAUDE_CODE_BIN=claude
CLAUDE_CODE_MODEL=sonnet
```

Optional web enrichment:

```env
FIRECRAWL_API_KEY=fc-...
FIRECRAWL_API_URL=https://api.firecrawl.dev/v2
```

## Usage

```bash
# prompt for username/options
bun run src/index.tsx

# scan (downloads the archive, then runs the multi-agent analysis)
bun run src/index.tsx spez

# scan 10 years of Reddit history with web search/scrape enrichment
bun run src/index.tsx --years 10 --web spez

# test a candidate identity as a hypothesis
bun run src/index.tsx --subject-name "Jane Doe" --web some_username

# write machine-readable findings
bun run src/index.tsx --json some_username

# open the web dashboard
bun run dashboard

# use Claude Code instead of an OpenAI-compatible API
bun run src/index.tsx --provider claude-code some_username
```

Reports are written to:

```text
reports/report_<username>_<timestamp>.md
reports/report_<username>_<timestamp>.json
```

## Web dashboard

Run the local dashboard when you want to browse older reports or start a scan
without living in the terminal:

```bash
bun run dashboard
```

It serves `http://localhost:4173` by default. Set `DASHBOARD_PORT` to use a
different port. The dashboard reads existing files from `reports/`, opens
Markdown/JSON reports, compares identifier overlap between reports, and launches
new scans through the same backend pipeline as the CLI.

## How a scan runs

Every scan downloads the account's history to local JSONL first (cached in `data/`), filters the corpus, runs separate agents for identity, location, career/education, behavioral signals, and digital footprint, then synthesizes the final report. If the archive download returns nothing, it falls back to a live agent that fetches Reddit history through tools. `--deep` is still accepted but does nothing.

## Project layout

```text
src/index.tsx              CLI entry point
src/reddit/download.ts     Reddit archive downloader
src/analysis/pipeline.ts   audit orchestration
src/analysis/deep-analysis.ts
src/analysis/extract.ts    deterministic email/handle extraction
src/runtime/               LLM providers, tools, Firecrawl client
src/config/models.ts       model defaults
reports/                   generated reports
data/                      downloaded JSONL
```

## Notes for analysts

Treat the output like an OSINT lead sheet, not ground truth. The useful parts are the quoted evidence, URLs, dates, and confidence labels. The risky parts are model synthesis and weak-signal aggregation; verify those before taking action.
