# Real estate page + worker changes - design

Date: 2026-09-20. Status: draft, awaiting review. Scope: sub-project 1 (foundation) and the worker
changes it needs. Later sub-projects (comps, workspace, map) get their own specs.

## Goal

A dedicated `/real-estate` dashboard page for property listings (sale and rent). The product pipeline
(group by `base_model`, compare to a median) is meaningless for property, and it already excludes real
estate via `price_lookup_excluded`. Property needs structured fields (area, beds, price basis, project)
before any research or "worth a look" ranking is possible.

Non-goals for this spec: comps and ranking, BIR zonal values, manual workspace, map view, photo-hash
dedup. Each depends on the foundation defined here.

## What prod data showed (snapshot 2026-09-20, read-only queries)

- 453 Real Estate listings, 415 active, 29 sold, 9 flagged removed. Data spans ~1 month (first seen 2026-08-19).
- Sub-categories: House & Lot 174, Condo/Apartment 166, Land 71, Other 27, Rentals 15.
- **Price is unusable on 174 of 415 active listings** (42%): values <= 1000 such as 2, 12, 13, 23, 350 on
  titles like "1 bedroom Portico Pasig" and "576 sqm Penthouse BGC". Likely shorthand for millions or
  thousands (unit unconfirmed).
- `location_city` is null on 413 of 415 active. Coordinates exist but 236 of 451 sit on points shared by
  3 or more listings (one point holds 37): coarse area centroids, not property-precise.
- Text signals over title + description: 67% state an area in sqm, 47% mention bedrooms, 26% mention title
  (TCT/CCT), 12% mention foreclosure/bank/Pag-IBIG, 11% mention RFO/pre-selling, 10% mention pasalo/assume.
- Sub-category is a poor sale/rent signal: 15 Rentals vs 110 listings with rent-related words.
- Only 6% marked sold; most listings vanish and get flagged removed.

## Worker facts that constrain the design (verified in code)

- Search URL is hardcoded `marketplace/manila/search/`, FB radius 65 km (`browser.ts`), local backstop
  80 km from Manila center (`location.ts`), and `purge-far-listings` deletes beyond it.
- `refreshListingFields` overwrites price, title, description on every recheck; no history is kept. It also
  sets `updated_at = now()` on every recheck, changed or not.
- `check-listings` rechecks all unsold listings ordered by staleness, category-blind.
- Product-level workers (`price-lookup`, `enrich-products`, `verify-discount-notifications`) already skip
  real estate. No change needed there.
- Workers are registered in `server/routes/workerControl.ts` (`WORKER_PID_FILES`), `server/routes/logs.ts`
  (`WORKER_LOG_FILES`), `package.json` scripts, and the dashboard admin logs page.

## Non-disruption rule

Set by the user 2026-09-20: nothing here may disrupt non-real-estate listings. Every change is additive,
gated to real estate, and defaults to today's behavior. Concretely:

- Existing tests pass unchanged. Any new behavior for existing code paths has its own tests, and a test
  proves a non-real-estate listing takes the old path.
- No change to the product pipeline (`extract-products`, `enrich-products`, `price-lookup`,
  `verify-discount-notifications`, `enrich-listing-prices`), `/deals`, `/products`, or notifications.
- New settings default to the current behavior. Real estate collection ships disabled until switched on.
- A failed real estate write (history, extraction) is logged and swallowed. It never fails a shared
  worker's run for other listings.
- Before and after each phase that touches a shared worker, compare non-real-estate throughput
  (listings collected per lap, listings rechecked per run, lap duration) and record it in the phase report.

## Decisions

| # | Decision | Value |
|---|---|---|
| 1 | Storage | Side table `real_estate_details`, 1:1 with `listings`, cascade delete. Product pipeline untouched. |
| 2 | Extractor | New worker `extract-real-estate`, Groq pool, same batching pattern as existing Groq workers. |
| 3 | Scope | Sale and rent on one page with a toggle. |
| 4 | Collection | Property phrases in `collect_keywords` with a new `kind` column so they run in their own capped pass. Plain rows would lengthen every lap and slow other categories, which the non-disruption rule forbids. |
| 5 | Price per sqm | Computed at query time, never stored. |
| 6 | Sale vs rent | From text only. Sub-category `Rentals` is at most a weak hint. |
| 7 | Location | `area_text` and `project_name` extracted from text. lat/lng treated as coarse. No barangay matching. |
| D1 | Geography v1 | **NCR only** (user, 2026-09-20). Service area stays 80 km from Manila, which already covers NCR. Region 4-A and beyond are deferred. |
| D2 | Price history | **Real estate listings only** in v1, to leave other categories untouched. Extending to all categories is a separate, later change. |
| D3 | No golden set (user, 2026-09-20) | A listing can only offer so much. What the LLM cannot resolve goes to **Under review** instead of being guessed. Quality check is a ~20-listing spot check by the user at the end of phase 2. |
| D4 | Under review rule | A listing needs review when its price basis is `unresolved`, its confidence is `low`, or sale/rent is unclear. It is excluded from the main list and shown on an Under review tab, read-only in v1. |
| D5 | `/products` | Unchanged. Real Estate stays visible there. |

## Design

### 1. `listing_price_history` (real estate listings only)

```
listing_price_history (
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  price_amount NUMERIC, price_currency TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, recorded_at)
)
```

In `refreshListingFields`, only when the listing's product category is Real Estate, read the stored price
before the update. If the new price differs: if the listing has no history rows yet, first insert the old
price stamped with `first_seen_at`, then insert the new price. Unchanged price writes nothing. The history
write is best-effort: on error it is logged and the listing refresh still completes. Non-real-estate
listings skip this branch entirely. Cascade delete matches the FK fix already made for
`listing_price_review`.

### 2. Recheck cadence

Add a setting `check_listings.re_recheck_min_days`, defaulting to 0 (today's behavior). When above 0,
`getCheckListingsCandidates` skips real estate listings checked more recently than that many days. Other
categories are unaffected. Exact query shape is settled in the plan. The settings PATCH allowlist and its
floors must include every new key (a missing entry caused a bug before, see commit `1f00b53`).

### 3. `real_estate_details`

```
real_estate_details (
  listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  listing_type TEXT CHECK (listing_type IN ('sale','rent')),
  property_type TEXT CHECK (property_type IN ('house_and_lot','condo','land','commercial','other')),
  price_php NUMERIC,
  price_basis TEXT CHECK (price_basis IN ('total','per_sqm','monthly','equity','unresolved')),
  lot_sqm NUMERIC, floor_sqm NUMERIC, bedrooms INT, bathrooms INT,
  project_name TEXT, area_text TEXT,
  tags JSONB NOT NULL DEFAULT '[]',          -- pasalo, foreclosure, rfo, preselling, has_title, ...
  confidence TEXT CHECK (confidence IN ('high','medium','low')),
  source_hash TEXT NOT NULL,                 -- hash of title|description|price_amount at extraction
  model TEXT NOT NULL,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

Null means the listing did not state the value. Never guessed. Additive migration in `db/schema.sql`,
idempotent, applied with `psql -f`.

### 4. Extractor domain module (`src/domains/marketplace/real-estate.ts`)

Pure functions, unit-tested first:

- Prompt builder and response schema with an object root `{results: [...]}` (Groq rejects array roots).
- **Price normalization:** deterministic pass first for shorthand in title/description ("13M", "1.5 mil",
  "500k"). When `price_amount` is implausibly small and the text has a matching amount, propose it. Otherwise
  the LLM decides `price_php` and `price_basis`. If neither resolves, `price_basis = 'unresolved'`.
- Unit conversion (sqft to sqm x0.0929, hectares x10,000) is done by the LLM per the prompt and validated by
  the clamps below, since only 1 of 453 listings uses sqft.
- Clamps turn implausible values into null with confidence downgraded: sale total outside 100k to 5B,
  monthly rent outside 1k to 1M, lot over 10M sqm, beds over 50.
- Ranges in the text produce null, not a midpoint.
- `area_text` is normalized to one of the 17 NCR LGUs (16 cities plus Pateros) when the text names one or a
  well-known district or project within one. Otherwise the raw text is kept. Outside-NCR values are stored
  as stated, not normalized (Region 4-A is out of scope for v1).

### 5. Storage and worker

- Candidates: listings (active or sold, never removed) whose product category is Real Estate and that have no
  details row, or whose stored `source_hash` differs from the current hash. `updated_at` is not used (it changes on every recheck).
- `src/workers/extract-real-estate/index.ts`: batches of 20 to 35, halving on persistent failure, quota
  handling, pid file, log. Modeled on `backfill-sub-categories` and `extract-products`.
- Depends on `extract-products` having assigned the Real Estate category, so it runs after it.
- Registered in the four places listed above.

### 6. Under review and spot check

No golden set or eval script (user, 2026-09-20). Anything the extractor cannot resolve is marked, not guessed:
`price_basis = 'unresolved'`, `confidence = 'low'`, or `listing_type` null. Those listings are "needs review" and
are derived at query time, not stored. At the end of phase 2 the assistant shows the user about 20 random
extracted listings next to their source text for a quick visual check. In a 77-listing sample about 44% had no
stated price, so roughly half the listings are expected to sit under review. That is a limit of the data.

### 7. Query and page

- `getRealEstateListings(filters)` in `server/queries.ts`, added to the registry in `server/routes/query.ts`
  and the dashboard client `dashboard/src/lib/queries.ts`. Filters: sale/rent, property type, area text,
  price range, min size, project. Sort and pagination.
- Price per sqm at query time, sale and `price_basis = 'total'` only: land and house_and_lot use `lot_sqm`,
  condo uses `floor_sqm`, commercial/other use `floor_sqm` else `lot_sqm`. Rent rows show monthly rent.
- `dashboard/src/app/real-estate/page.tsx` (`force-dynamic`) plus a client component: filters, sale/rent
  toggle, confidence badges. The main list shows only listings that do not need review; an Under review tab
  shows the rest with the reason (read-only in v1; manual price entry can come later). Reuses the existing
  listing detail modal.
  `NavLinks` gets an exact-match entry. The dashboard's `AGENTS.md` says its Next version is non-standard,
  so the relevant docs in `node_modules/next/dist/docs/` are read before writing page code.

### 8. Collection expansion

- `collect_keywords` gets a `kind` column (`'general'` default, so every existing row keeps today's
  behavior). Real estate phrases use `kind = 'real_estate'`.
- `collect` runs the general keywords exactly as today. Real estate keywords run in a separate pass every
  N laps (`collect.re_every_n_laps`, default 3), capped by `collect.re_max_items`, and only when
  `collect.re_keywords_enabled` is 1 (default 0, so shipping the code changes nothing until it is switched
  on). New settings need entries in the PATCH allowlist and floors.
- NCR-first keyword set, staged: start with just `house and lot` (user, 2026-09-20) and watch lap duration
  before adding more.
- Region 4-A and a real estate service-area radius are deferred (D1). If added later they need a per-kind
  radius setting and `purge-far-listings` reading the same setting.
- Spike (optional, after NCR works): category-scoped Facebook search (`commerce_search_and_rp_category_id`
  is currently empty). Needs a carefully paced live test. Feasibility unknown.

## Phases and pause points

Each phase ends with a stop for user review before the next one starts. One branch per phase, tests first,
root, server and dashboard suites green before any commit. No commits without the user asking.

| Phase | Contents | Exit criteria |
|---|---|---|
| 0 | Confirm the first keyword set (`house and lot`) | Keyword agreed |
| 1 | Price history (real estate only), recheck cadence setting, `collect_keywords.kind` and the gated real estate pass, first 3-4 NCR keywords | Non-real-estate throughput unchanged versus baseline, price rows appear for real estate rechecks, real estate pass verified with the flag on |
| 2 | Schema, domain module, storage, worker, backfill of existing real estate listings, spot check | User's ~20-listing spot check looks right, unresolved share reported |
| 3 | Query, registry entry, page, nav entry | Page renders real prod rows, low-confidence rows marked, other pages unchanged |
| 4 | More NCR keywords, category-search spike | Volume grows, pacing holds |

## Deploy

Prod deploys are manual: `scp` the changed files to `/home/scraper/buy-and-sell-ai/`, `chown scraper:scraper`,
apply schema with `psql -f`, restart. Restarting `buy-and-sell-server.service` kills running workers
(`KillMode=control-group`) and briefly takes the dashboard down, so it is done at a quiet moment.
Explicit user go-ahead before every deploy. Diff each target file first so VPS-only work is not clobbered.

## Risks

- LLM accuracy on price shorthand. Mitigation: price comes from the text only, clamps turn implausible values into `unresolved`, and the Under review tab holds what is unclear. A confidently wrong price is only caught by the clamps and the spot check.
- Facebook pacing: more keywords means longer laps and more block risk. Mitigation: staged rollout,
  no burst live testing.
- Prod box is one vCPU already at load ~2. Extraction is small (453 listings, ~15 batches) but is watched.
- The dashboard depends on the VPS server being up.
- ~1 month of data, so rental and Region 4-A coverage may stay thin until keywords add volume.

## Open questions

- Final first-keyword set for NCR (confirmed at the start of phase 1).
- Exact shape of the recheck-cadence query and the collect real estate pass (settled during planning).
- Where the dashboard admin logs page lists workers (to add the new one).
