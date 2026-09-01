# Session Resume

Plan for next session: add a Settings page to the dashboard for tuning worker cadence/batch/pacing/retry knobs and discount-policy thresholds, currently all hardcoded source constants.

Grilled and revised 2026-09-01 — see "Decided" and knob list for what changed from the original survey.

## Context

Survey of every worker (`src/workers/*`) turned up hardcoded numeric constants that are really operator-tunable knobs: loop delay between laps, items processed per lap, per-item pacing delays, retry attempts/backoff, plus four cross-cutting discount-policy thresholds consumed by `verify-discount-notifications`. None of these currently have an env var override — editing them means editing source and redeploying. Full list below, grouped by worker, with current value and file:line.

`backfill-sub-categories` (`src/utils/`) is a one-off manual utility, not a recurring managed worker (not in `admin/logs/page.tsx`'s `WORKERS` array) — **excluded from this page's scope**.

## Decided (confirmed by user)

- **Persistence:** new Postgres `settings` key/value table, not `.env` edits. Workers read it fresh each lap (same pattern `check-listings` already uses re-querying candidates every lap) — changes apply within one lap, no restart, matches the app's existing Postgres-single-source-of-truth convention (see `CONTEXT.md` on removing the local JSONL that used to double as a second source of truth).
- **Scope:** everything from the survey, including retry/backoff counts and all four discount-policy thresholds — not just cadence/batch/pacing. `min_profit_pesos`/`min_price_pesos` were previously marked "not user-configurable yet, per direct instruction" in `listings.ts` comments (2026-08-30/31) — **that instruction is overruled**; both are in scope now. Update those comments when implementing.
- **Nav:** top nav (`site-header`), not a side nav — app only has ~5 flat links today, side nav is unwarranted structural churn for one more link. Add `Settings` next to the existing `Workers` link.
- **`collect.test_loop_delay_ms` dropped from scope** — only fires when `cycle && isTestRun()` (`collect/index.ts:143`), never touches production/live Facebook calls. Not a real operator knob; leave as a source constant. Checked the other 6 workers' `isTestRun()` branches — they only skip the `realDelay` call in test mode, they don't swap out a separate constant, so this exclusion is unique to `collect`.
- **`gemini_daily_grounding_cap` wiring:** `createDailyGroundingCap(client, limit, now)` in `src/domains/llm-clients/gemini.ts` (not `.../marketplace/llm-clients/...` — that path in the original survey was wrong) currently captures `limit` once at wrapper-construction time, not per-call. Change its signature to accept a live getter so this knob fits the same "no restart" pattern as the others. No extra UI hard-max needed — confirmed this is the free tier only, not a billed key, so the overage-cost concern the code comment raises doesn't apply operationally (comment can stay, it's still accurate about the free-tier RPD ceiling).
- **`refresh.ts` / `refreshProduct.ts` on-demand routes:** wire both to `check_listings.soft_wall_timeout_ms` via `loadSettings` too, instead of leaving them on `checkOneListing`'s hardcoded default (`= 5000`). Otherwise editing the setting in the dashboard silently desyncs on-demand refresh from the worker.
- **`discount_policy.high_discount_threshold_percent` — fix an existing duplication bug while wiring it live.** `listings.ts:416`'s `HIGH_DISCOUNT_THRESHOLD` (used in the actual notification gate) and `discount-verification.ts:117`'s hardcoded `30%` literal in the LLM prompt text are two independent numbers today — they only happen to agree by coincidence, `discount-verification.ts` doesn't import the constant. Wire **both** call sites to the same live settings value (export `HIGH_DISCOUNT_THRESHOLD`, interpolate it into the prompt string). Wiring only the gate and leaving the prompt hardcoded would make the LLM verify against a stale bar after any dashboard edit — worse than the current coincidental agreement.
- **Validation floors** (replaces the original "≥0" blanket rule):
  - Count-based knobs (batch sizes, limits, attempts) — floor of **1**, not 0. Several feed `for (...; i += BATCH_SIZE)`-shaped loops (confirmed at `enrich-products/index.ts:77`, same shape at `extract-products/index.ts:341`) that hang forever (infinite loop, spins CPU) if the step is 0.
  - `*_ms` pacing/delay knobs — general floor **1000ms**.
  - The FB-facing knobs specifically (`collect.pacing_min_ms`/`pacing_max_ms`, `check_listings.pacing_min_ms`/`pacing_max_ms`, and both workers' `loop_delay_ms`) — floor **2000ms** for pacing, **10000ms** for loop delay. These are the ones that throttle live requests against Facebook; a fat-fingered low value risks the exact rate-limit/ban scenario already flagged as a standing concern for this project.
  - `pacing_min_ms ≤ pacing_max_ms` enforced as a pair on save, not just each field independently.
  - Percent knobs (`high_discount_threshold_percent`) clamped `0–100` as before.
- **Schema type: `INTEGER`, not `NUMERIC`.** `pg` returns `NUMERIC`/`BIGINT` columns as JS strings (not numbers) to avoid float-precision loss on the wire, and this codebase has no `pg.types.setTypeParser` override — checked `src/platform/storage*` and `dashboard/src/lib/*.ts`, none exists. Every value in the knob list is a whole integer (ms/counts/percent/pesos, nothing fractional), so `INTEGER` sidesteps the string-cast footgun entirely with no downside.
- **No audit/history log** for settings changes (just `updated_at`) — unchanged from original plan, revisit if "who changed what when" becomes needed.

## Full knob list (key → current value)

Naming convention: `<worker>.<knob>`, snake_case, dot-separated group prefix (mirrors `WORKERS` array ids where the worker has one).

**collect** (`src/workers/collect/index.ts`)
- ~~`collect.test_loop_delay_ms`~~ — dropped, see Decided
- `collect.max_items_default` = 100 (L50) — default per-query item cap when no CLI arg given
- `collect.soft_wall_timeout_ms` = 5000 (L134) — soft-wall retry wait before failing closed
- `collect.pacing_min_ms` / `collect.pacing_max_ms` = 4000 / 10000 (`src/run.ts:135,190`, shared `waitRandom` call inside `runCollection`) — FB-facing, floor 2000ms

**check-listings** (`src/workers/check-listings/index.ts`)
- `check_listings.loop_delay_ms` = 60000 (L99) — FB-facing, floor 10000ms
- `check_listings.limit_default` = 100 (L136)
- `check_listings.soft_wall_timeout_ms` = 5000 (L45, L110 default params) — also read by `refresh.ts`/`refreshProduct.ts`, see Decided
- `check_listings.pacing_min_ms` / `check_listings.pacing_max_ms` = 2000 / 4000 (L115) — FB-facing, floor 2000ms

**extract-products** (`src/workers/extract-products/index.ts`)
- `extract_products.max_attempts` = 5 (L65)
- `extract_products.retry_base_delay_ms` = 30000 (L66) — exponential backoff base
- `extract_products.loop_delay_ms` = 300000 (L71)
- `extract_products.batch_size` = 100 (L341)
- `extract_products.inter_batch_delay_ms` = 5000 (L342, also L167 fallback)

**enrich-products** (`src/workers/enrich-products/index.ts`)
- `enrich_products.batch_size` = 20 (L34)
- `enrich_products.loop_delay_ms` = 300000 (L42)
- `enrich_products.max_attempts` = 3 (L50)
- `enrich_products.retry_delay_ms` = 3000 (L51)

**price-lookup** (`src/workers/price-lookup/index.ts`)
- `price_lookup.lap_limit_default` = 20 (L15)
- `price_lookup.loop_delay_ms` = 300000 (L16)
- `price_lookup.pacing_delay_ms` = 1000 (L37)

**enrich-listing-prices** (`src/workers/enrich-listing-prices/index.ts`)
- `enrich_listing_prices.batch_size` = 35 (L13) — comment flags this as unverified/guessed
- `enrich_listing_prices.loop_delay_ms` = 300000 (L19)

**verify-discount-notifications** (`src/workers/verify-discount-notifications/index.ts`)
- `verify_discount.lap_limit_default` = 3 (L33) — paid-API candidates/lap
- `verify_discount.fetch_batch_size` = 50 (L40) — free-precheck rows/lap
- `verify_discount.loop_delay_ms` = 30000 (L41)
- `verify_discount.pacing_delay_ms` = 1000 (L83)

**discount-policy** (cross-cutting, consumed by `verify-discount-notifications`' logic)
- `discount_policy.high_discount_threshold_percent` = 30 — currently `HIGH_DISCOUNT_THRESHOLD` at `src/domains/marketplace/storage/listings.ts:416` (not exported) AND a separate hardcoded `30%` literal in `src/domains/marketplace/discount-verification.ts:117`'s LLM prompt text — see Decided, both need wiring
- `discount_policy.min_profit_pesos` = 1000 (`listings.ts:424`, exported, also used in `discount-verification.ts:120` prompt text)
- `discount_policy.min_price_pesos` = 500 (`listings.ts:437`, exported, also used in `discount-verification.ts:197`)
- `discount_policy.gemini_daily_grounding_cap` = 1000 — `DEFAULT_DAILY_GROUNDING_CAP` at `src/domains/llm-clients/gemini.ts:47` (path corrected, see Decided)

## Implementation plan

### 1. Schema (`db/schema.sql`, append — same idempotent `CREATE TABLE IF NOT EXISTS` convention already used throughout the file)
```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
Followed by one `INSERT INTO settings (key, value) VALUES (...) ON CONFLICT (key) DO NOTHING` per row above (idempotent — re-running schema.sql after an operator has already tweaked a value won't clobber it).

### 2. Shared helper — `src/platform/settings.ts` (new)
- `SETTING_DEFAULTS: Record<string, number>` — mirrors the seed values above, used as fallback if a key is somehow missing from the table (defensive, not expected to hit once schema.sql has run).
- `loadSettings(db, keys: string[]): Promise<Record<string, number>>` — one `SELECT key, value FROM settings WHERE key = ANY($1)`, falls back per-key to `SETTING_DEFAULTS`.

### 3. Wire each worker
Same shape for all seven: at the top of the `for (;;)` loop (each lap), call `loadSettings` with that worker's key list, replace the module-level `const LOOP_DELAY_MS` etc. reads inside the loop body with the freshly-loaded values. File:line targets are the survey list above — module consts become the `SETTING_DEFAULTS` source instead of being read directly.

Also wire (not just the seven worker loops):
- `refresh.ts` / `refreshProduct.ts` — read `check_listings.soft_wall_timeout_ms` per-request before calling `checkOneListing`.
- `discount-verification.ts` — read `discount_policy.high_discount_threshold_percent` / `min_profit_pesos` / `min_price_pesos` and interpolate into the LLM prompt string (currently hardcoded/duplicated, see Decided).
- `gemini.ts`'s `createDailyGroundingCap` — change `limit` param to a live getter (`() => Promise<number>` or similar), read `discount_policy.gemini_daily_grounding_cap` per call instead of capturing once at construction.

### 4. Dashboard backend
- `dashboard/src/lib/queries.ts`: `getAllSettings(): Promise<{key: string, value: number, updatedAt: string}[]>`, `updateSettings(updates: {key: string, value: number}[]): Promise<void>` (single `UPDATE ... FROM (VALUES ...)` batch, same shape as the app's other bulk-update helpers).
- `dashboard/src/app/api/settings/route.ts`: `GET` returns all rows, `PATCH` accepts `{key, value}[]`, validates per the floors in Decided (count knobs ≥1, generic `*_ms` ≥1000, FB-facing pacing ≥2000/loop-delay ≥10000, percent 0–100, `pacing_min ≤ pacing_max` pairwise).

### 5. Dashboard UI
- `dashboard/src/app/admin/settings/page.tsx` (new, client component, same shape as `admin/logs/page.tsx`): fetch `GET /api/settings` on mount, render grouped sections (one per worker + one "Discount Policy" section), each field a labeled number input with an `InfoTooltip` for the description (reuse today's component instead of a plain label — same pattern as `WORKER_DESCRIPTIONS`, but now consistent with the rest of the app instead of one more one-off).
- A `SETTINGS_METADATA` array (key, label, description, group, unit, min/step) lives dashboard-side, kept in sync by hand — same precedent as `admin/logs/page.tsx`'s `WORKER_DESCRIPTIONS` (comment there already documents why: dashboard/ and the worker scripts are separate packages with no shared import path).
- Save per section (matches the grouping), not per-field or one global save-all — fewer accidental partial-saves, still fast to iterate.
- Nav: `dashboard/src/app/layout.tsx:74-76` — add a `Settings` `Link` to `/admin/settings`, next to the existing `Workers` link.

### 6. Verification
- `pnpm test` (root): new tests for `src/platform/settings.ts` (`loadSettings` fallback behavior when a key is missing).
- `pnpm test` (dashboard): new tests for `getAllSettings`/`updateSettings` in `queries.test.ts`, following the existing test-DB pattern; validation-floor rejection cases in the route handler tests.
- Manual: run one worker locally, edit its loop delay via the dashboard, confirm the next lap's log line reflects the new value without a restart.
