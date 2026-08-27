# Session Resume

Regenerated live (not hand-edited from the last version) — this doc's own rule: regenerate, don't trust blindly once time has passed. Reflects only the most recent session (domains/modular-monolith refactor + TEST_RUN + live DB migration + worker log viewer design), not prior sessions.

## Repo / deploy state (live-verified)

- Local HEAD: `953ae50` "add worker log viewer design doc"
- **`git status`: clean.** Every commit this session landed for real (27 commits, `e240815`..`953ae50`), typecheck + full test suite green after each one.
- Tests: `npx vitest run` → 48 files, 387 tests, all passing
- Typecheck: `npx tsc --noEmit -p .` → clean
- Not pushed to remote this session (all local commits on `main`).
- Hetzner/Vercel/tunnel deploy state: **not re-verified this session** — no deploy happened. `server/` and the dashboard's `REFRESH_SERVER_URL` proxy pattern were read (not changed) as prep for the log-viewer design.

## DB state

**Live-verified this session.** Ran the full `db/schema.sql` (idempotent, `IF NOT EXISTS` throughout) against production Neon in one transaction via `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/schema.sql` (needed `PGSSLROOTCERT=system` — Neon's `sslmode=verify-full` couldn't find `~/.postgresql/root.crt`). Confirmed live: `product_enrichment.is_specific_product`, `product_enrichment.confidence`, `products.price_lookup_review_status` all now exist. 14b's `applyEligibilityFromEnrichment` and the review-status gating are unblocked in prod — this was the single item carried over from two sessions ago.

## What happened this session (chronological)

1. **Committed the ~80-file working tree from the prior session** (never committed at the time) as 8 logical commits: schema, enrichment 14b prompt, price-lookup batching, category-backfill/candidate helpers, price-review interface, dashboard price-invalidation, docs, and the big worker/storage directory restructure. Deleted two scratch FB GraphQL capture files (`graphQLCalls.txt`/`graphQLResponses.txt`) rather than committing them.
2. **Naming/structure cleanup, each its own commit**, driven by user questions about inconsistent naming:
   - Split `src/workers/` into `src/workers/` (7 looping) + `src/utils/` (6 manual one-off scripts) — worker count had drifted from an earlier "7" plan to 13 total dirs before this split.
   - Renamed `src/workers/cli` → `collect` (only worker dir not matching its `pnpm run <name>` script).
   - Renamed `price-lookup`/`new-price-lookup` → `secondhand-price-lookup`/`retail-price-lookup` (names didn't distinguish "used market price via Gemini" from "brand-new retail price via Exa").
   - Flattened `src/storage/client.ts` → `src/storage.ts` (single-file dir, no reason to be a dir).
3. **Full "modular monolith" restructure** (`src/domains/`), planned via `writing-plans` skill (11-task plan, `docs/superpowers/plans/2026-08-27-domains-modular-monolith.md`), executed inline (not subagent-driven — explicit user call: skip the heavy multi-agent SDD pipeline for a solo project, direct implementation + TDD is enough). Result:
   - `src/domains/marketplace/` — all scraping/pricing/product business logic **and persistence** (`storage/listings.ts`, `storage/products.ts`, `storage/pricing.ts`, consolidated from what used to be 13 separate per-worker `storage.ts` files), one barrel `index.ts`.
   - `src/domains/llm-clients/` — gemini/exa/groq wrappers, one barrel. Had to disambiguate a real `isQuotaError` name collision between gemini.ts and groq.ts (`isGeminiQuotaError`/`isGroqQuotaError`).
   - `src/platform/` — DB connection, images, logger, review, generic utils. Not a domain, cross-cutting.
   - `src/workers/` (7) and `src/utils/` (6) reduced to thin entrypoints — zero domain logic of their own now (caught and moved two things that had drifted into `utils/`: `CANONICAL_BASE_MODEL` canonicalization map, and duplicate `PriceReviewData`/`EnrichmentData` interfaces that would have collided in the barrel).
   - `README.md` project-layout section rewritten to match.
4. **Added `TEST_RUN=true` dry-run mode** (`isTestRun()` in `platform/utils.ts`) across all 7 workers — each still connects to Postgres and queries its real candidate set, but skips the actual paid/live call (Gemini/Groq/Exa/live Facebook) and logs what it would have called instead. User's own framing: "see all the workers running before we actually call anything and spend resources." Live-verified against real Neon data (extract-products found 1492 real candidates, retail-price-lookup found 3248, etc. — see log tails from this session if needed).
5. **Ran all 7 workers concurrently with `TEST_RUN=true`** for 30s as a live validation — no crashes, no DB pool contention, candidate-count numbers were internally consistent with the pipeline's dependency order (e.g. retail-price-lookup's much larger backlog than secondhand-price-lookup's makes sense given its 20/lap spend cap).
6. **Converted `check-listings` to an actual loop** — it was one-shot despite being counted among "the 7 looping workers" everywhere else (README, this doc's own prior version). Now `for(;;) { poll; batch; sleep }` like the rest, 5min `LOOP_DELAY_MS`, browser session launched once and reused across laps. Live-verified.
7. **Designed (not yet built) a worker log viewer for the dashboard.** Used `brainstorming` skill (architectural path — spans backend+frontend, not pure UI) after confirming with the user that no other skill fit better for this planning phase. Spec written and committed: `docs/superpowers/specs/2026-08-27-worker-log-viewer-design.md`. Design in brief: `POST /logs` on `server/` (allowlisted worker-key → log file, offset-based tail, reuses existing Bearer auth — no new auth/transport/deploy step), proxied by a new `dashboard/src/app/api/logs/route.ts` matching the existing `refresh-job` proxy pattern, rendered at a new `/admin/logs` page (already covered by the dashboard's existing cookie-auth middleware, no new gate needed). Polling only (3s), not SSE — matches the existing `refresh-job` polling precedent, no new transport. User confirmed workers + `server/` run on the same Hetzner VPS (shared filesystem, no cross-host log access problem).

## Deferred / open threads (not done, explicitly flagged)

- **Worker log viewer: spec approved and committed, implementation not started.** User asked for the resume prompt right after approving "implement directly, no formal plan doc, TDD" — so next session should go straight to implementation against `docs/superpowers/specs/2026-08-27-worker-log-viewer-design.md`, no `writing-plans`/subagent detour needed (already agreed).
- `/admin/review` dashboard page (14b's `needs_review` queue UI — Approve/Reject actions) — still designed, not built. Now genuinely unblocked (DB migration is live), was blocked on that before.
- `pm2 ecosystem.config.js` — tool decided (pm2 over systemd) two sessions ago, file still never written, nothing running under pm2. Workers are still started by hand.
- Not pushed to remote — 27 local commits on `main` ahead of whatever's on the remote, never pushed this session.
- Batch-size audits still unverified (carried over, untouched this session): `enrich-listing-prices.ts`'s `35`, `backfill-categories.ts`'s `100`.
- Gemini batch-size ceiling above 5 untested (carried over, blocked by daily quota mid-test in a much earlier session).

## Useful commands

- `npx vitest run` — 48 files, 387 tests
- `npx tsc --noEmit -p .` — typecheck
- `TEST_RUN=true npx tsx src/workers/<name>/index.ts` — dry-run any single worker against real data without spending money/hitting live Facebook (`.env` already has `TEST_RUN=true`; unset it or pass `TEST_RUN=false` for a real run)
- `pnpm run collect` / `check-listings` / `extract-products` / `enrich-products` / `secondhand-price-lookup` / `retail-price-lookup` / `enrich-listing-prices` — all 7 loop forever now
- `pnpm run backfill-images` / `backfill-categories` / `flag-negotiable-keywords` / `flag-price-ineligible` / `merge-duplicate-products` / `price-from-listings` — the 6 manual one-off scripts, under `src/utils/`
- `PGSSLROOTCERT=system psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/schema.sql` — the exact command used to apply the schema live this session; safe to re-run (idempotent), same fix needed for Neon's `sslmode=verify-full` if `~/.postgresql/root.crt` still doesn't exist
- `gh auth switch --user k-b3r` if push fails "Repository not found" (account drifts back to `kimbermudez` periodically) — **not re-verified this session** (nothing was pushed)
