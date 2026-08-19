# buy-and-sell-ai

Personal Facebook Marketplace intelligence tool — collects publicly visible listings (logged-out, no account used) to help spot potentially undervalued buy-and-sell opportunities in the Philippines. ₱0 budget, runs locally.

Full product vision: [`PRODUCT_DESCRIPTION.md`](./PRODUCT_DESCRIPTION.md). Living design/decision log (source of truth for current behavior): [`CONTEXT.md`](./CONTEXT.md).

## Status

v0 — proof of concept. Collector works end-to-end against real Facebook Marketplace. No database, no analytics, no deal scoring yet (see `PRODUCT_DESCRIPTION.md` for the roadmap).

## How it works

- **No login, no account** — reads listing data Facebook serves to a logged-out browser session. Zero account-ban risk; this was a deliberate architecture choice after confirming automated collection violates Meta's ToS regardless of login state (see `CONTEXT.md` → "Collector").
- **Headless, human-paced** — randomized 4-10s delays between navigations, manual y/n/stop review before anything is saved. No visible browser window (switched from headed once the pipeline was proven stable).
- **Two-stage per listing** — grid search results first (fast, low navigation), then each listing's detail page individually (slower, where pacing matters most).
- **Pagination beyond the first 24** — Facebook only serves 24 listings per search by default; the collector can fetch more via the same internal API the site itself uses for infinite-scroll, still logged-out.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
```

## Usage

```bash
pnpm run collect -- "<search query>" [maxItems]
```

Example:

```bash
pnpm run collect -- "Sony WH-1000XM6" 50
```

- Defaults: query `headphones`, `maxItems` unset (single 24-item batch, no pagination).
- Walks listings one at a time in the background (headless). For each: `[y]es` approves and saves it, `[n]o` skips it, `[s]top` ends the run early.
- Approved listings land in `data/listings.jsonl` (JSON Lines — one listing object per line). Logs go to `data/collector.log`.
- No location argument — there's no reliable logged-out location filtering signal (see `CONTEXT.md` → "Location filter"). Results are centered on Metro Manila/Cavite via a hardcoded location slug.

## Testing

```bash
pnpm test
```

Unit tests cover extraction, parsing, pacing/wall-handling logic, and the orchestration loop, all against fixtures — no live network calls in the test suite.

## Project layout

```
src/
  logger.ts, output.ts, review.ts     # logging, JSONL output, CLI y/n/stop prompt
  wall.ts                              # detects soft login-walls vs hard blocks
  extract/grid.ts, extract/detail.ts   # parse listing data out of Facebook's embedded JSON
  paginate.ts                          # cursor/token extraction, pagination response parsing
  driver.ts, browser.ts                # browser abstraction (real Playwright implementation)
  run.ts                               # orchestration loop
  cli.ts                               # entrypoint
test/, fixtures/                       # unit tests against real-shaped fixture data
docs/superpowers/plans/                # implementation plans this was built from
```

## Safety notes

- Never introduces login/cookies/session — if you're extending this, keep it that way; that's the whole risk-mitigation strategy.
- If Facebook shows a CAPTCHA or unrecognized page state, the collector stops and logs it rather than guessing or retrying — check `data/collector.log` and any `data/debug-*.html` dumps.
- Don't remove the pacing delays or run this unattended/scheduled — manual, human-paced runs are part of what keeps this low-risk.
