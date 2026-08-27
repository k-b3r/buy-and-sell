# Session Resume

Regenerated live (not hand-edited from the last version) — this doc's own rule: regenerate, don't trust blindly once time has passed. Reflects only the most recent session (pipeline-consolidation continuation + worker/storage restructure), not prior sessions.

## Repo / deploy state (live-verified)

- Local HEAD: `e240815` "convert flag-price-ineligible to looping worker, expand exclusion list"
- **`git status`: NOT clean — ~80 changed paths uncommitted.** This entire session's work (see below) is sitting in the working tree, never committed, never pushed, never deployed. Only 2 commits from earlier in this same session landed (`279320f` test import-path fixes, `e240815` flag-price-ineligible worker conversion) — everything after that point is uncommitted.
- Tests: `npx vitest run` → 56 files, 386 tests, all passing (against the uncommitted working tree)
- Typecheck: `npx tsc --noEmit -p .` → clean
- Hetzner/Vercel/tunnel state: **not re-verified this session** — no live deploy, SSH, or tunnel check happened. Treat prior session's notes on these as stale; re-verify before trusting.

## DB state

**Not live-verified this session — no psql queries run against Neon.** Two schema additions were written to `db/schema.sql` but **never applied to the live database**:
- `product_enrichment.is_specific_product` (boolean, nullable), `product_enrichment.confidence` (text, nullable)
- `products.price_lookup_review_status` (text, nullable)

These are additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements (safe, non-breaking) but the migration has not been run live. Code that reads/writes these columns (enrichment prompt, `applyEligibilityFromEnrichment`, candidate-query gating) will fail against the live DB until it's applied.

## What happened this session (chronological)

1. Resumed from `~/.claude/plans/pipeline-consolidation.md`. Verified two things the plan claimed were already committed actually weren't — committed them for real (test import-path fixes, `flag-price-ineligible` worker-loop conversion).
2. Walked the collection pipeline stage-by-stage (raw FB field mapping in `parseListingFields`, candidate-query dependency order across all workers) — discussion only, no code changes.
3. **Built 14b (pricing-eligibility review queue)**: `enrich-products`'s Groq call now also returns `is_specific_product`/`confidence`; `applyEligibilityFromEnrichment` auto-excludes high-confidence generics (reuses `price_lookup_excluded`) and flags low-confidence ones `needs_review` (new column). Both pricing candidate queries gated on the new column. **DB migration not yet applied live** (see above).
4. **Inline `base_model` canonicalization**: `extract-products` now checks `CANONICAL_BASE_MODEL` before creating a product, so known aliases (`PS5`/`PlayStation 5` etc.) collapse onto the same product at creation — no separate merge needed for known cases.
5. **Worker roster consolidated**: `flag-price-ineligible` and `merge-duplicate-products` demoted from workers to manual one-off scripts (run by hand, not looped/deployed). Group A dropped from a planned 7 to 5 continuously-running workers.
6. Applied the `for(;;) { poll; batch; sleep }` loop to the remaining one-shot Group A workers (`extract-products`, `price-lookup`, `new-price-lookup`, `enrich-listing-prices`). `new-price-lookup` capped at `DEFAULT_LAP_LIMIT=20`/lap since it's the only one spending real money (Exa, ~$0.007/call) — explicit tradeoff, confirmed with user.
7. **`price-lookup.ts` reworked to batch** (was 1 product/call, live-testing earlier this session proved 5/call works with no cross-contamination) — fenced-json-in-free-text parsing (Gemini grounding can't use structured output). Quota backoff retuned 10min→1hr (was 2min→30min).
8. Renamed `review-listing-prices.ts` → `enrich-listing-prices.ts` for naming consistency with `enrich-products` (same shape: resumable via `NOT EXISTS`, loops, LLM-classifies each row).
9. **Dashboard**: listings matching `enrich-listing-prices`'s full candidate criteria (magnitude outlier >10x median OR placeholder digit-pattern like `123`/`999`/`12,567`) now have `price_amount` hidden entirely (returned `null`), not just excluded from discount scoring. New `isPriceInvalidated` helper in `dashboard/src/lib/queries.ts`.
10. **Backend**: ported the placeholder-price digit-pattern check (previously dashboard-only) into `getPriceReviewCandidates`'s SQL — flags placeholder prices as review candidates independent of magnitude, and excludes them from the median computation itself.
11. **Large structural refactor** (took 2 wrong passes before landing on the right shape — user corrected the architecture twice): every one of the 13 worker entrypoint scripts moved from `src/<name>.ts` to `src/workers/<name>/index.ts`. Each worker gained its own `storage.ts` holding its DB queries (cross-worker imports where one worker's table is read/written by another, e.g. `new-price-lookup/storage.ts` imports `insertPriceCheck` from `../price-lookup/storage`). `db.ts` and `category-backfill.ts` deleted, fully redistributed. `DbClient`/`createDbPool` isolated to `src/storage/client.ts`. Generic non-domain helpers (`DelayFn`, `realDelay`, `loadEnvFile`) consolidated into `src/utils.ts`. `package.json` scripts, `README.md`, and `server/` cross-package imports all updated to match.

## Deferred / open threads (not done, explicitly flagged)

- **Nothing from this session is committed except the first 2 items.** ~80 files uncommitted — needs a deliberate multi-commit plan before pushing (14b, canonicalization, worker consolidation, price-lookup batching, loop conversions, price-invalidation, placeholder-price port, and the full worker/storage directory reorg are all separate logical changes bundled in one working tree right now).
- **DB migration not applied live** — the two schema additions above need to actually run against Neon before 14b's code path works in production.
- `/admin/review` dashboard page (14b's `needs_review` queue UI — Approve/Reject actions) — designed, not built.
- `pm2 ecosystem.config.js` — tool decided (pm2 over systemd), file never written, nothing running under pm2.
- Tavily-for-retail swap — investigated extensively in a prior session, explicitly **reversed** this session (user decided to keep Exa). No code change needed (never actually switched).
- Batch-size audits still unverified: `enrich-listing-prices.ts`'s `35`, `backfill-categories.ts`'s `100`.
- Gemini batch-size ceiling above 5 untested (blocked by daily quota mid-test, prior session).
- `groq/compound` — live-tested this session, found a real reliability gap (413 errors on specific branded-product queries), **not adopted**.
- Group B (`collect`/`check-listings`) pacing — decided to stay fully independent, no shared pacer (confirmed with user, different listing sets).

## Useful commands

- `pnpm run collect` / `check-listings` / `extract-products` / `enrich-products` / `price-lookup` / `new-price-lookup` / `enrich-listing-prices` — all loop forever now (paths moved under `src/workers/<name>/index.ts`, script names unchanged)
- `pnpm run flag-price-ineligible` — now a manual one-shot, run after editing `PRICE_INELIGIBLE_CATEGORIES`
- `pnpm run merge-duplicate-products` — manual one-shot, newly given a `package.json` entry this session (had none before)
- `npx vitest run` — 56 files, 386 tests
- `npx tsc --noEmit -p .` — typecheck
- `gh auth switch --user k-b3r` if push fails "Repository not found" (account drifts back to `kimbermudez` periodically) — **not re-verified this session**
