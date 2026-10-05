# buy-and-sell-ai

Personal Facebook Marketplace intelligence tool — collects publicly visible listings (logged-out, no account used) to help spot potentially undervalued buy-and-sell opportunities in the Philippines. ₱0 budget, runs locally.

Full product vision: [`PRODUCT_DESCRIPTION.md`](./PRODUCT_DESCRIPTION.md). Living design/decision log (source of truth for current behavior): [`CONTEXT.md`](./CONTEXT.md).

## Status

v0 — proof of concept. Collector works end-to-end against real Facebook Marketplace. No database, no analytics, no deal scoring yet (see `PRODUCT_DESCRIPTION.md` for the roadmap).

## How it works

- **No login, no account** — reads listing data Facebook serves to a logged-out browser session. Zero account-ban risk; this was a deliberate architecture choice after confirming automated collection violates Meta's ToS regardless of login state (see `CONTEXT.md` → "Collector").
- **Headless, human-paced** — randomized 4-10s delays between navigations. Auto-approves every listing (switched from manual y/n/stop review once extraction quality was verified). No visible browser window (switched from headed once the pipeline was proven stable).
- **Two-stage per listing** — grid search results first (fast, low navigation), then each listing's detail page individually (slower, where pacing matters most).
- **Pagination beyond the first 24** — Facebook only serves 24 listings per search by default; the collector can fetch more via the same internal API the site itself uses for infinite-scroll, still logged-out.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
```

Required: create `.env` with `DATABASE_URL="postgresql://..."` (a free [Neon](https://neon.tech) project works well — see `CONTEXT.md` → "Storage" for why Neon over Supabase), then apply the schema:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

Postgres is the sole source of truth — the collector won't start without `DATABASE_URL` set (see `CONTEXT.md` on removing the local JSONL file that used to double as one).

Optional, for photo storage: Facebook's photo carousel URLs are signed and expire in days, so the collector re-hosts them to Cloudflare R2 (free 10GB tier) at collection time. Create an R2 bucket + API token, then add to `.env`: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_BASE_URL` (the bucket's public dev URL or custom domain). Without these, photo URLs are still captured in `raw_json`/`listing_photos` but not downloaded — they'll go dead once Facebook's signature expires.

## Usage

```bash
pnpm run collect -- "<search query>" [maxItems] [daysSinceListed]
```

Example:

```bash
pnpm run collect -- "Sony WH-1000XM6" 50
pnpm run collect -- "headphones" 100 7   # only listings posted in the last 7 days
```

- Defaults: query `headphones`, `maxItems` unset (single 24-item batch, no pagination), `daysSinceListed` 30.
- `maxItems` is a per-run budget of _new_ items (capped at 1000), not a lifetime total — already-saved listings (any query, any prior run) are skipped via dedup regardless, so re-running the same command after a crash just continues collecting fresh ones on top of what's already saved.
- `daysSinceListed` narrows the search to recently-posted listings — useful for periodic re-runs of the same keyword (e.g. weekly with `7`), since it shrinks the pool to mostly-new-since-last-time listings instead of re-wading through a wide window of stuff you already have (dedup skips those anyway, but this avoids burning pagination budget getting past them).
- Walks listings one at a time in the background (headless), auto-approving each and saving it — no manual review step anymore.
- Listings already in Postgres from a prior run (any machine — it's the shared source of truth) are skipped entirely (not re-opened, not re-saved), so re-running the same query is safe and cheap.
- Approved listings are upserted into Postgres. Logs go to `data/collector.log`.
- No location argument — there's no reliable logged-out location filtering signal (see `CONTEXT.md` → "Location filter"). Results are centered on Metro Manila/Cavite via a hardcoded location slug.

## Backfilling images for already-collected listings

```bash
pnpm run backfill-images -- [limit]
```

Re-visits each already-saved listing live (paced same as a normal run) to pick up its full photo carousel and re-host it to R2 — needed for listings collected before the carousel-extraction fix and R2 storage existed (they only ever got `primary_listing_photo`, no `listing_photos`). Resumable: progress written after every listing, already-backfilled ones (have `stored_photo_urls`) skipped on the next run. Optional `limit` caps how many to process this run. Logs to `data/backfill.log`. Requires R2 and `DATABASE_URL`.

## Testing

```bash
pnpm check              # format check, lint, typecheck, unit tests: run before every PR
pnpm format             # apply Prettier
pnpm test               # unit tests only
pnpm test:integration   # needs TEST_DATABASE_URL
pnpm test:e2e           # needs TEST_DATABASE_URL; builds the dashboard, starts it and the server
```

Unit tests cover extraction, parsing, pacing/wall-handling logic, and the orchestration loop, all against fixtures — no live network calls in the test suite.

Integration (`*.int.test.ts`) and e2e (`e2e/`) tests apply `db/schema.sql` to the database in `TEST_DATABASE_URL` and write to it. Point it at a disposable database, never prod (it is deliberately not `DATABASE_URL`). A throwaway local one:

```bash
docker run -d --rm --name bas-test-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bas_test -p 55432:5432 postgres:17
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/bas_test
```

CI (`.github/workflows/`) runs every check above on each PR, plus an agent review against the coding standards and a gate: a PR labeled `agent-changes-requested`, or `needs-human` without `human-approved`, fails the gate.

## Project layout

```
src/
  domains/
    llm-clients/                        # shared LLM/search clients (Gemini, Groq, Exa, Tavily, OpenRouter),
                                        # fallback pools, retry, error classification
      index.ts                          # public API, SDK-free
      gemini-sdk.ts, groq-sdk.ts        # the only files loading @google/genai / groq-sdk; workers import by path
  modules/                              # feature modules (see CONTEXT.md > Architecture)
    catalog/                            # products: extraction, enrichment, categories, dedup/merge,
                                        # model-code mismatches, catalog dashboard queries
      index.ts                          # public API — nothing imports its internals (dependency-cruiser)
    collection/                         # browser, proxy/tunnel, pagination, wall detection, extraction,
                                        # run loop, recheck, listing upsert, listing photos, collect keywords
      index.ts                          # public API; browser.ts is the only other entry (Playwright)
    pricing/                            # price lookup, price review, clean median, discounts,
                                        # generic-product check, pricing dashboard queries
      index.ts                          # public API — nothing imports its internals (dependency-cruiser)
    real-estate/                        # extraction, real_estate_details, price history, dashboard query
      index.ts                          # public API — nothing imports its internals (dependency-cruiser)
  platform/                             # cross-cutting, not a domain
    storage.ts                          # DbClient/createDbPool — Postgres connection, sole entry point
    worker.ts                           # runWorker — every worker's lap loop, pid/log files, pool lifecycle
    settings.ts                         # DB-backed runtime settings with SETTING_DEFAULTS fallback
    images.ts, logger.ts, review.ts, delay.ts, env.ts, errors.ts, rows.ts, redact.ts, browserLock.ts
  workers/                              # the 8 looping, continuously-running processes
    collect/, check-listings/           # Group B: collection (independent pacing)
    extract-products/, enrich-products/, price-lookup/,
    enrich-listing-prices/              # Group A: pricing pipeline (shared pacing)
    extract-real-estate/, verify-discount-notifications/
  utils/                                # one-off scripts, run by hand, not looped/deployed — no domain
    backfill/, detect-generic-products/,  # logic of their own, everything domain-shaped lives in modules/
    detect-model-mismatches/, reassign-model-mismatches/, flag-price-ineligible/,
    merge-duplicate-products/, price-from-listings/
  each worker/util dir: index.ts entrypoint, wiring only (ESLint blocks oversized or complex ones);
  workers loop via runWorker, collect via its own laps.ts
server/                                 # VPS HTTP server: auth, named-query whitelist, refresh, worker control
  routes/                               # one handler per route, wiring only (same ESLint limits)
dashboard/                              # Next.js app, thin RPC client over server/
db/schema.sql                           # single source of schema truth
scripts/                                # gen-arch-doc, deploy, backup, tunnel
tests/                                  # integration/, e2e/, lint-config.test.ts
*.test.ts colocated next to the file it tests; fixtures/ for shared fixture data
docs/superpowers/plans/                 # implementation plans this was built from
```

## Safety notes

- Never introduces login/cookies/session — if you're extending this, keep it that way; that's the whole risk-mitigation strategy.
- If Facebook shows a CAPTCHA or unrecognized page state, the collector stops and logs it rather than guessing or retrying — check `data/collector.log` and any `data/debug-*.html` dumps.
- Don't remove the pacing delays or run this unattended/scheduled — manual, human-paced runs are part of what keeps this low-risk.
