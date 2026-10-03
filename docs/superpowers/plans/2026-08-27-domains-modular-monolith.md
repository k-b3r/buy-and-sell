# Domains Modular Monolith Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `src/domains/` so business logic (marketplace scraping/pricing/products, and LLM/search clients) lives separately from `src/workers/` and `src/utils/` (thin entrypoints), modular-monolith style — no new behavior, pure move/consolidation.

**Architecture:** Two domains: `domains/marketplace` (all business logic + all persistence for listings/products/pricing) and `domains/llm-clients` (Gemini/Exa/Groq wrappers). Cross-cutting non-domain code (DB connection, image storage, logging, review, generic helpers) moves to `src/platform/`. Every domain exposes one barrel `index.ts`; `workers/`, `utils/`, and `run.ts` import only from the barrel, never a domain's internal files. `utils/*` scripts keep zero business logic of their own — anything that isn't pure script-wiring (arg parsing, main loop) moves into `domains/marketplace`.

**Tech Stack:** TypeScript, tsx, vitest. No new dependencies.

**Spec:** This plan's own header + Global Constraints below (decided via user Q&A this session, no separate spec doc).

## Global Constraints

- Domains own persistence too: DB query functions currently colocated per-worker (`workers/*/storage.ts`, `utils/*/storage.ts`) move into `domains/marketplace/storage/*.ts`. Workers/utils keep no `storage.ts` of their own once this is done — they call the domain instead.
- Two domains only: `domains/marketplace` (collection, products, pricing — one bounded context, they're already tightly cross-coupled) and `domains/llm-clients` (gemini/exa/groq — spans marketplace concerns, e.g. gemini is used by both extraction and pricing).
- Cross-cutting infra (DB connection factory, image storage, logging, auto-approve review, generic helpers) is not a domain — lives in `src/platform/`.
- Every domain has exactly one barrel `index.ts` re-exporting its full public surface. Importers (`workers/`, `utils/`, `run.ts`) import only `../../domains/marketplace` / `../../domains/llm-clients`, never a deeper path into the domain.
- `run.ts` stays at `src/run.ts` (orchestration layer above domain code, not domain code itself).
- `utils/*` must have zero domain logic left in them after this plan — if a util currently holds a business constant (e.g. a canonical-name map) or a DB query, it moves to `domains/marketplace`.
- No behavior changes. Every task ends with `npx tsc --noEmit -p .` clean and `npx vitest run` at 386/386 passing before commit.

---

## Current inventory (source of truth for the moves below)

Root `src/*.ts` (non-test) library files today:
`browser.ts, driver.ts, enrichment.ts, exa.ts, gemini.ts, groq.ts, images.ts, logger.ts, negotiable-keywords.ts, new-price.ts, paginate.ts, price-review.ts, pricing.ts, products.ts, review.ts, run.ts, storage.ts, tunnel.ts, utils.ts, wall.ts`, plus `src/extract/{grid,detail}.ts`.

Per-worker/util `storage.ts` exports (everything that must land in `domains/marketplace/storage/*`):

| File                                         | Exports                                                                                                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workers/collect/storage.ts`                 | `parseListingFields`, `upsertListing`, `getCollectedListingIds`                                                                                                                                                                 |
| `workers/check-listings/storage.ts`          | `CheckListingsCandidate`, `getCheckListingsCandidates`, `getListingCheckCandidatesForProduct`, `getListingCheckCandidate`, `markListingAlive`, `markListingSold`, `flagListingRemoved`, `deleteListing`, `refreshListingFields` |
| `utils/backfill/storage.ts`                  | `BackfillCandidate`, `getBackfillCandidates`, `markListingPhotosUnavailable`                                                                                                                                                    |
| `utils/flag-negotiable-keywords/storage.ts`  | `NegotiableKeywordCandidate`, `getNegotiableKeywordCandidates`                                                                                                                                                                  |
| `workers/enrich-listing-prices/storage.ts`   | `getPriceReviewCandidates`, `upsertListingPriceReview`, `upsertKeywordNegotiable`, `flagNegotiableFromKeywords`                                                                                                                 |
| `workers/extract-products/storage.ts`        | `findOrCreateProduct`, `updateListingProductIds`, `ExtractionCandidate`, `getExtractionCandidates`                                                                                                                              |
| `workers/enrich-products/storage.ts`         | `getEnrichmentCandidates`, `EnrichmentData`, `upsertProductEnrichment`, `applyEligibilityFromEnrichment`                                                                                                                        |
| `utils/backfill-categories/storage.ts`       | `getCategoryBackfillCandidates`, `updateProductCategories`                                                                                                                                                                      |
| `utils/merge-duplicate-products/storage.ts`  | `mergeDuplicateProduct`                                                                                                                                                                                                         |
| `utils/flag-price-ineligible/storage.ts`     | `flagPriceLookupExcluded`                                                                                                                                                                                                       |
| `workers/secondhand-price-lookup/storage.ts` | `getPriceLookupCandidates`, `PriceCheckSource`, `insertPriceCheck`                                                                                                                                                              |
| `workers/retail-price-lookup/storage.ts`     | `getNewPriceCandidates`, `flagProductPriceLookupExcluded`                                                                                                                                                                       |
| `utils/price-from-listings/storage.ts`       | `ListingPricesForProductCondition`, `getListingPricesByProduct`                                                                                                                                                                 |

Plus one business constant currently mislaid in a util: `CANONICAL_BASE_MODEL` (`utils/merge-duplicate-products/index.ts`), used by `workers/extract-products/index.ts` — moves into `domains/marketplace/products.ts`.

Target consolidation:

- `domains/marketplace/storage/listings.ts` ← collect, check-listings, backfill(util), flag-negotiable-keywords(util), enrich-listing-prices
- `domains/marketplace/storage/products.ts` ← extract-products, enrich-products, backfill-categories(util), merge-duplicate-products(util), flag-price-ineligible(util)
- `domains/marketplace/storage/pricing.ts` ← secondhand-price-lookup, retail-price-lookup, price-from-listings(util)
- `domains/marketplace/storage/index.ts` barrel re-exporting the three above

---

### Task 1: Scaffold `src/platform/`

**Files:**

- Move: `src/storage.ts` → `src/platform/storage.ts`
- Move: `src/images.ts` → `src/platform/images.ts`
- Move: `src/logger.ts` → `src/platform/logger.ts`
- Move: `src/review.ts` → `src/platform/review.ts`
- Move: `src/utils.ts` → `src/platform/utils.ts`
- Move their `*.test.ts` alongside each
- Modify: every file across `src/`, `server/` that imports any of these five by their old root path

**Interfaces:** No signature changes — pure path move. Produces: `../platform/storage`, `../platform/images`, `../platform/logger`, `../platform/review`, `../platform/utils` as the new import roots for later tasks.

- [ ] **Step 1:** `git mv src/storage.ts src/storage.test.ts src/platform/` (repeat for images, logger, review, utils.ts + their .test.ts; `review.ts` and `logger.ts` — check which have `.test.ts` first with `ls src/*.test.ts`)
- [ ] **Step 2:** Repo-wide path fix. For each of the 5 modules, run:
  ```bash
  grep -rl "from '\(\.\./\)*storage'" --include=*.ts . | grep -v node_modules | xargs sed -i "s|\(\.\./\)*storage'|\1platform/storage'|"
  ```
  Do this per-module and per relative depth (`../storage`, `../../storage`, `./storage` from files still at `src/` root, etc) — safest is to `grep -rn "from '.*\(storage\|images\|logger\|review\|utils\)'"` first, inspect matches, then fix each import line individually rather than a blanket sed (module names like `utils` are common enough that a global sed on the bare word is unsafe — filter to import lines whose resolved target is one of these 5 files, not e.g. `../../new-price` or unrelated `utils` locals).
- [ ] **Step 3:** `npx tsc --noEmit -p .` — fix any remaining broken import until clean.
- [ ] **Step 4:** `npx vitest run` — confirm 386/386 pass.
- [ ] **Step 5:** Commit: `git add -A -- src/ server/ && git commit -m "move DB client, images, logger, review, utils to src/platform/"`

---

### Task 2: Scaffold `domains/llm-clients`

**Files:**

- Move: `src/gemini.ts`, `src/gemini.test.ts`, `src/exa.ts`, `src/exa.test.ts`, `src/groq.ts` (+ test if present) → `src/domains/llm-clients/`
- Create: `src/domains/llm-clients/index.ts` — barrel re-exporting every public export of the three files
- Modify: every importer of `../gemini`, `../exa`, `../groq` (or deeper relative equivalents) to import from `../../domains/llm-clients` instead

**Interfaces:** Barrel re-exports whatever each file currently exports (check with `grep -n "^export" src/gemini.ts src/exa.ts src/groq.ts` before writing the barrel — do not guess names).

- [ ] **Step 1:** `mkdir -p src/domains/llm-clients && git mv src/gemini.ts src/gemini.test.ts src/exa.ts src/exa.test.ts src/groq.ts src/domains/llm-clients/` (adjust for whichever `.test.ts` files actually exist)
- [ ] **Step 2:** Write `src/domains/llm-clients/index.ts`:
  ```ts
  export * from './gemini'
  export * from './exa'
  export * from './groq'
  ```
- [ ] **Step 3:** Find and fix every importer: `grep -rln "from '.*\(gemini\|exa\|groq\)'" --include=*.ts . | grep -v node_modules | grep -v domains/llm-clients` — change each to import from the correct relative path to `domains/llm-clients` (barrel), not the old file path.
- [ ] **Step 4:** `npx tsc --noEmit -p .` clean.
- [ ] **Step 5:** `npx vitest run` — 386/386.
- [ ] **Step 6:** Commit: `git commit -m "move gemini/exa/groq clients to domains/llm-clients"`

---

### Task 3: Scaffold `domains/marketplace` (business logic, no storage yet)

**Files:**

- Move: `src/browser.ts`, `src/driver.ts`, `src/paginate.ts`, `src/wall.ts`, `src/tunnel.ts` (+ tests) → `src/domains/marketplace/`
- Move: `src/extract/grid.ts`, `src/extract/detail.ts` (+ tests) → `src/domains/marketplace/extract/`
- Move: `src/pricing.ts`, `src/new-price.ts`, `src/price-review.ts` (+ tests) → `src/domains/marketplace/`
- Move: `src/products.ts`, `src/enrichment.ts`, `src/negotiable-keywords.ts` (+ tests) → `src/domains/marketplace/`
- Create: `src/domains/marketplace/index.ts` — barrel re-exporting every public export of all the above (not storage yet — that's Tasks 5-7)
- Modify: every importer across `src/`, `server/`

**Interfaces:** Re-export everything each file currently exports (`grep -n "^export" <file>` on each before writing the barrel).

- [ ] **Step 1:** `mkdir -p src/domains/marketplace/extract`, then `git mv` each file listed above into place (grid/detail into the `extract/` subdir, the rest flat under `domains/marketplace/`).
- [ ] **Step 2:** Write `src/domains/marketplace/index.ts` re-exporting from all 11 moved modules (`./browser`, `./driver`, `./paginate`, `./wall`, `./tunnel`, `./extract/grid`, `./extract/detail`, `./pricing`, `./new-price`, `./price-review`, `./products`, `./enrichment`, `./negotiable-keywords`) via `export * from './x'`. Watch for name collisions across these files (run `grep -hn "^export" <all 11 files>` and confirm no two files export the same identifier before finalizing — if there is a collision, re-export that one explicitly by name instead of via `export *`).
- [ ] **Step 3:** Fix every importer (`grep -rln "from '.*\(browser\|driver\|paginate\|wall\|tunnel\|pricing\|new-price\|price-review\|products\|enrichment\|negotiable-keywords\)'" --include=*.ts . | grep -v node_modules | grep -v domains/marketplace`) to import from the domain barrel instead of the old path. Also fix `import ... from './extract/grid'` / `'./extract/detail'` style imports (currently only `run.ts` and `check-listings` reach these directly).
- [ ] **Step 4:** `npx tsc --noEmit -p .` clean.
- [ ] **Step 5:** `npx vitest run` — 386/386.
- [ ] **Step 6:** Commit: `git commit -m "move marketplace business logic (scraping/pricing/products) to domains/marketplace"`

---

### Task 4: Move `CANONICAL_BASE_MODEL` out of utils

**Files:**

- Modify: `src/utils/merge-duplicate-products/index.ts` — remove `CANONICAL_BASE_MODEL` export, keep the rest (the merge-run script logic that _uses_ it)
- Modify: `src/domains/marketplace/products.ts` — add `CANONICAL_BASE_MODEL` export
- Modify: `src/workers/extract-products/index.ts` — import `CANONICAL_BASE_MODEL` from `../../domains/marketplace` instead of `../../utils/merge-duplicate-products`
- Modify: `src/utils/merge-duplicate-products/index.ts` — import `CANONICAL_BASE_MODEL` from `../../domains/marketplace` for its own use

**Interfaces:** `CANONICAL_BASE_MODEL: Record<string, string>` — same shape, new home.

- [ ] **Step 1:** Cut the `CANONICAL_BASE_MODEL` object out of `utils/merge-duplicate-products/index.ts`, paste it into `domains/marketplace/products.ts`, add `export`.
- [ ] **Step 2:** Add `CANONICAL_BASE_MODEL` to the `domains/marketplace/index.ts` barrel if not already covered by `export * from './products'`.
- [ ] **Step 3:** Update the two importers (`workers/extract-products/index.ts`, `utils/merge-duplicate-products/index.ts` itself) to `import { CANONICAL_BASE_MODEL } from '../../domains/marketplace'`.
- [ ] **Step 4:** `npx tsc --noEmit -p .` clean, `npx vitest run` 386/386.
- [ ] **Step 5:** Commit: `git commit -m "move CANONICAL_BASE_MODEL business data out of utils into domains/marketplace"`

---

### Task 5: Consolidate listings storage (collect, check-listings, backfill util)

**Files:**

- Create: `src/domains/marketplace/storage/listings.ts`
- Move into it, verbatim (adjust relative import depth only): all exports of `workers/collect/storage.ts`, `workers/check-listings/storage.ts`, `utils/backfill/storage.ts`
- Move: their `*.test.ts` content into `src/domains/marketplace/storage/listings.test.ts` (merge three test files into one, keep every test case, dedupe shared fixture setup)
- Delete: `workers/collect/storage.ts`, `workers/collect/storage.test.ts`, `workers/check-listings/storage.ts`, `workers/check-listings/storage.test.ts`, `utils/backfill/storage.ts`, `utils/backfill/storage.test.ts`
- Modify: `workers/collect/index.ts`, `workers/check-listings/index.ts`, `utils/backfill/index.ts`, `src/run.ts`, and any other cross-importer (`server/routes/refresh.ts`, `server/routes/refreshProduct.ts`, `server/index.ts` — these import `getListingCheckCandidate(sForProduct)` and `checkOneListing` today) to import from `../../domains/marketplace/storage` (or the domain barrel, if storage is re-exported there too — see Task 8) instead of the old per-worker path.

**Interfaces:** Produces (unchanged signatures): `parseListingFields`, `upsertListing`, `getCollectedListingIds`, `CheckListingsCandidate`, `getCheckListingsCandidates`, `getListingCheckCandidatesForProduct`, `getListingCheckCandidate`, `markListingAlive`, `markListingSold`, `flagListingRemoved`, `deleteListing`, `refreshListingFields`, `BackfillCandidate`, `getBackfillCandidates`, `markListingPhotosUnavailable`.

- [ ] **Step 1:** Create `src/domains/marketplace/storage/listings.ts`, paste in all listed exports from the 3 source files, fix their internal relative imports (e.g. `DbClient` now from `../../../platform/storage`).
- [ ] **Step 2:** Merge the 3 corresponding `.test.ts` files into `src/domains/marketplace/storage/listings.test.ts`, importing from `./listings`.
- [ ] **Step 3:** Delete the 6 old files (3 storage.ts + 3 storage.test.ts).
- [ ] **Step 4:** Fix every importer found via `grep -rln "workers/collect/storage\|workers/check-listings/storage\|utils/backfill/storage"` (excluding the new location) to point at `domains/marketplace/storage/listings`.
- [ ] **Step 5:** `npx tsc --noEmit -p .` clean, `npx vitest run` 386/386 (test count should not drop — merged file keeps every case).
- [ ] **Step 6:** Commit: `git commit -m "consolidate listings storage (collect/check-listings/backfill) into domains/marketplace"`

---

### Task 6: Fold negotiable-keywords + enrich-listing-prices into listings storage

**Files:**

- Modify: `src/domains/marketplace/storage/listings.ts` — append exports from `utils/flag-negotiable-keywords/storage.ts` and `workers/enrich-listing-prices/storage.ts`
- Modify: `src/domains/marketplace/storage/listings.test.ts` — append their test cases
- Delete: `utils/flag-negotiable-keywords/storage.ts(.test.ts)`, `workers/enrich-listing-prices/storage.ts(.test.ts)`
- Modify: `utils/flag-negotiable-keywords/index.ts`, `workers/enrich-listing-prices/index.ts`, and cross-importers (`utils/backfill/index.ts` and others use `upsertKeywordNegotiable`/`flagNegotiableFromKeywords` per current cross-worker imports — check with grep, don't assume) to import from the domain.

**Interfaces:** Adds to `listings.ts`: `NegotiableKeywordCandidate`, `getNegotiableKeywordCandidates`, `getPriceReviewCandidates`, `upsertListingPriceReview`, `upsertKeywordNegotiable`, `flagNegotiableFromKeywords`.

- [ ] **Step 1:** Append the two files' exports into `listings.ts`, fixing relative imports.
- [ ] **Step 2:** Append their test cases into `listings.test.ts`.
- [ ] **Step 3:** Delete the 4 old files.
- [ ] **Step 4:** `grep -rln "flag-negotiable-keywords/storage\|enrich-listing-prices/storage"` (excluding domains/marketplace) and fix each importer.
- [ ] **Step 5:** `npx tsc --noEmit -p .` clean, `npx vitest run` 386/386.
- [ ] **Step 6:** Commit: `git commit -m "fold negotiable-keywords and price-review listing storage into domains/marketplace"`

---

### Task 7: Consolidate products storage (extract-products, enrich-products)

**Files:**

- Create: `src/domains/marketplace/storage/products.ts`
- Move into it: all exports of `workers/extract-products/storage.ts`, `workers/enrich-products/storage.ts`
- Create: `src/domains/marketplace/storage/products.test.ts` merging both `.test.ts` files
- Delete: the 4 old files
- Modify: `workers/extract-products/index.ts`, `workers/enrich-products/index.ts`, cross-importers

**Interfaces:** `findOrCreateProduct`, `updateListingProductIds`, `ExtractionCandidate`, `getExtractionCandidates`, `getEnrichmentCandidates`, `EnrichmentData`, `upsertProductEnrichment`, `applyEligibilityFromEnrichment`.

- [ ] **Step 1-6:** Same pattern as Task 5 (create → merge tests → delete olds → fix importers → typecheck/test → commit `"consolidate extract/enrich-products storage into domains/marketplace"`).

---

### Task 8: Fold backfill-categories, merge-duplicate-products, flag-price-ineligible into products storage

**Files:**

- Modify: `src/domains/marketplace/storage/products.ts` — append exports of `utils/backfill-categories/storage.ts`, `utils/merge-duplicate-products/storage.ts`, `utils/flag-price-ineligible/storage.ts`
- Modify: `src/domains/marketplace/storage/products.test.ts` — append their tests
- Delete: the 6 old files
- Modify: `utils/backfill-categories/index.ts`, `utils/merge-duplicate-products/index.ts`, `utils/flag-price-ineligible/index.ts`, cross-importers (`workers/enrich-products/index.ts` imports `updateProductCategories` today — verify with grep)

**Interfaces:** Adds `getCategoryBackfillCandidates`, `updateProductCategories`, `mergeDuplicateProduct`, `flagPriceLookupExcluded`.

- [ ] **Step 1-6:** Same pattern (append → append tests → delete olds → fix importers → typecheck/test → commit `"fold category-backfill/merge-duplicate/flag-ineligible storage into domains/marketplace"`).

---

### Task 9: Consolidate pricing storage

**Files:**

- Create: `src/domains/marketplace/storage/pricing.ts`
- Move into it: all exports of `workers/secondhand-price-lookup/storage.ts`, `workers/retail-price-lookup/storage.ts`, `utils/price-from-listings/storage.ts`
- Create: `src/domains/marketplace/storage/pricing.test.ts` merging the 3 test files
- Delete: the 6 old files
- Modify: `workers/secondhand-price-lookup/index.ts`, `workers/retail-price-lookup/index.ts`, `utils/price-from-listings/index.ts`, cross-importers (retail-price-lookup currently imports `insertPriceCheck` from secondhand's storage — becomes an intra-file call once both are in `pricing.ts`, no import needed at all for that one)

**Interfaces:** `getPriceLookupCandidates`, `PriceCheckSource`, `insertPriceCheck`, `getNewPriceCandidates`, `flagProductPriceLookupExcluded`, `ListingPricesForProductCondition`, `getListingPricesByProduct`.

- [ ] **Step 1-6:** Same pattern (commit `"consolidate secondhand/retail price-lookup and price-from-listings storage into domains/marketplace"`).

---

### Task 10: Finalize storage barrel, sweep, delete empty dirs

**Files:**

- Create: `src/domains/marketplace/storage/index.ts` — `export * from './listings'`, `export * from './products'`, `export * from './pricing'` (check for cross-file name collisions first)
- Modify: `src/domains/marketplace/index.ts` — add `export * from './storage'`
- Sweep: `grep -rln "workers/[a-z-]*/storage'\|utils/[a-z-]*/storage'" --include=*.ts .` (excluding domains/marketplace) — should return nothing; fix any straggler
- Delete: any now-empty `workers/*/` or `utils/*/` directories are fine to leave (they still hold `index.ts`/`index.test.ts` — only `storage.ts`/`storage.test.ts` were removed)

**Interfaces:** N/A — pure barrel wiring.

- [ ] **Step 1:** Write the two barrel files.
- [ ] **Step 2:** Run the sweep grep, confirm empty.
- [ ] **Step 3:** `npx tsc --noEmit -p .` clean, `npx vitest run` 386/386.
- [ ] **Step 4:** Commit: `git commit -m "add domains/marketplace storage barrel, finish storage consolidation sweep"`

---

### Task 11: Update README project layout

**Files:**

- Modify: `README.md` — replace the "Project layout" `src/` tree to describe `domains/marketplace/`, `domains/llm-clients/`, `platform/`, `workers/` (7), `utils/` (6)

- [ ] **Step 1:** Rewrite the layout block with accurate paths (verify against actual `find src -maxdepth 2 -type d` output at this point, don't guess).
- [ ] **Step 2:** Commit: `git commit -m "update README project layout for domains/platform split"`

---

## Self-Review

**Spec coverage:** All 6 Q&A decisions covered — persistence-in-domains (Tasks 5-9), marketplace+llm-clients naming (Tasks 2-3), platform/ (Task 1), barrel index (every task), run.ts stays put (never moved), utils zero-domain-logic (Task 4 + every util's storage.ts emptied by Tasks 5-9).

**Placeholder scan:** Every task names exact files and exact export lists pulled from live `grep` output, not guessed. Sed/grep commands given are real, runnable — flagged the one place (Task 1 Step 2) where a blanket sed is unsafe and named the safer alternative explicitly instead of hand-waving "add validation"-style.

**Type consistency:** No renamed signatures anywhere in this plan — every move is verbatim relocation, so no drift risk between tasks.
