# Module layout: capability files and a `store/` folder

Status: draft for review, 2026-10-14. No code changed yet.

## Problem

`src/modules/*` are feature modules (`docs/architecture-cleanup-plan.md` moved away from `src/domains/*/storage/` layer folders). Nothing defines the inside of a module, so each one grew its own convention. Measured 2026-10-14:

- **DB calls have no home.** Catalog has `.query(` calls in four files under three names: `product-storage.ts` (14), `queries.ts` (5), `product-merge.ts` (3), `review-queue.ts` (2). Pricing has them in seven (`queries`, `price-triage`, `exclusion`, `discount-notifications`, `price-history`, `listing-price-review`, `deals`). Collection in three, real-estate in three. Several files mix decisions and SQL (`product-merge.ts`, `price-triage.ts`, `deals.ts`).
- **One concern split across files.** Extraction: `products.ts` holds `buildExtractionPrompt` and `EXTRACTION_RESPONSE_SCHEMA`, `extraction.ts` holds `parseExtractionItem`, `run-extraction.ts` holds the loop. Merge SQL is split across `product-storage.ts:mergeDuplicateProduct` and `product-merge.ts`.
- **Names by pipeline stage.** `run-enrichment`, `run-extraction`, `run-model-mismatches`, `run-price-review`, `run-discount-verification`, `run-price-lookup`: 0 direct DB calls each, pure orchestration, kept apart from the sibling that holds their prompt and parse code. The global standard asks for grouping "by feature, not by technical layer or pipeline stage".
- **Flat and large.** Catalog has 24 source files, pricing 21, no subfolders.

Debugging cost: finding "who runs this SQL" means grepping four to seven files with no naming signal.

## Fit check (record in `CONTEXT.md` when accepted)

Shape stays modular monolith; module boundary unchanged. This spec only fixes the inside of a module. `store/` is a layer folder, but bounded by one feature module, so one change still lives in one top-level folder. Chosen because it makes "all SQL" greppable and lintable.

## Convention

A module folder contains:

| Path                      | Holds                                                       | Rule                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                | public API                                                  | unchanged; only what callers outside use                                                                                                                               |
| `schemas.ts`, `routes.ts` | zod schemas, express router                                 | transport; only `server/` imports `routes.ts` (existing depcruise rule)                                                                                                |
| `<capability>.ts`         | one capability: prompt, parse, decide                       | noun names (`extraction`, `enrichment`, `merge`, `model-mismatch`). No `run-`, no verb prefix. Calls `store/` and injected clients. No SQL. No `run*` loop (see below) |
| `<capability>/`           | same, split when the file passes the line hint              | `prompt.ts`, `parse.ts`, and `<capability>.ts` for the decisions. Never `run.ts`                                                                                       |
| `store/<entity>.ts`       | every `.query(` call, params, row mapping                   | one file per entity or read model. No decisions (no retry, ranking, "should we"). Takes `db: DbClient` or `QueryClient`                                                |
| `store/*.test.ts`         | query-shape and param assertions                            | the query is the contract                                                                                                                                              |
| `extract/`                | existing DOM extractors in collection, real-estate, catalog | unchanged                                                                                                                                                              |

Existing rules kept: tests next to the file, injected `db`/`logger`/`delay`, constant SQL fragments allowed anywhere (only `.query(` calls are restricted).

Shared SQL fragments (pricing's price laterals, outlier and clean-median CTEs, used by catalog and collection queries) live in `pricing/store/fragments.ts` and are exported through `pricing/index.ts` as today. They contain no `.query(` call.

### Lint rule (tool)

In `eslint.config.js` (repo-specific block): `no-restricted-syntax` on `CallExpression[callee.property.name='query']` for `src/modules/**/*.ts`, off for `src/modules/**/store/**` and `*.test.ts`. A baseline list turns the rule off for modules not yet migrated, so it can land with the catalog PR. Each later PR removes its module from the baseline; empty baseline = done. Covered by `tests/lint-config.test.ts`.

### Run loops live in the caller (decision 2026-10-14)

`src/modules/*` hold only business logic: decisions, prompts, parsing, `store/`. An orchestration loop named `run*` (batching, pacing, retry, stop conditions) is called by exactly one worker or util `index.ts` and has no other caller, so it moves out of the module into the caller's folder as a sibling `run.ts` (`src/workers/enrich-products/run.ts`). `index.ts` stays pure wiring (the thin-entry lint rules apply to `index.ts` only); `run.ts` and its `run.test.ts` sit next to it.

- Modules export capabilities: what a loop uses from a module (store functions, prompt and parse helpers, types, constants) is exported by name through the module's `index.ts`. `run.ts` imports from `modules/<name>` index only, no deep imports, no `export *`, no unused exports (knip).
- Loop tests move with the loop (`run.test.ts`); helper tests stay with the module.
- Fit check: unchanged (modular monolith). A loop with a second caller, or logic worth testing apart from the loop, is a capability and stays in the module under a noun name.
- Enforced by `no-restricted-syntax` in `eslint.config.js` (an `export` of a function, const or specifier named `/^run[A-Z]/` in `src/modules/**`, tests excepted), applied to the modules listed in `RUN_FREE_MODULES` (one per line; each module's PR appends its own). Covered by `tests/lint-config.test.ts`.
- Order: catalog and real-estate first; collection and pricing in their own PRs.

## File map

Function allocation inside `store/` is proposed; the PR for each module settles it.

### catalog (pilot)

| Today                                                             | Target                                                                                                                                                                           |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product-storage.ts` (14 db)                                      | `store/products.ts` (find/create, category update, merge, listing product ids, matched listings), `store/enrichment.ts` (candidates, upsert), `store/extraction.ts` (candidates) |
| `queries.ts` (5 db, 466 loc)                                      | `store/product-list.ts` (summaries, tree, sold counts), `store/product-detail.ts`                                                                                                |
| `review-queue.ts` (2 db)                                          | `store/review-queue.ts`                                                                                                                                                          |
| `product-merge.ts` (3 db + logic)                                 | `merge.ts` (decisions, alias rules) + SQL into `store/products.ts`                                                                                                               |
| `run-enrichment.ts` + `enrichment.ts`                             | `enrichment.ts` (prompt, parse); the loop moves to `src/workers/enrich-products/run.ts` (see Run loops)                                                                          |
| `run-extraction.ts` + `extraction.ts` + prompt from `products.ts` | `extraction.ts` (prompt, schema, parse); the loop moves to `src/workers/extract-products/run.ts` (see Run loops)                                                                 |
| `run-model-mismatches.ts` + `model-mismatch.ts`                   | `model-mismatch.ts`                                                                                                                                                              |
| `products.ts` (normalization, categories)                         | `products.ts`, minus the extraction prompt                                                                                                                                       |
| `variant-alias-rules.ts`                                          | unchanged (data table)                                                                                                                                                           |

### pricing

| Today                                                                                                                                             | Target                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `queries.ts` (9 db)                                                                                                                               | `store/dashboard.ts` (or per page if it passes the line hint)                              |
| `exclusion.ts` (6), `discount-notifications.ts` (5), `price-history.ts` (4), `listing-price-review.ts` (3), `price-triage.ts` (6), `deals.ts` (2) | decision code stays in the same-named capability file; SQL moves to `store/<same-name>.ts` |
| `run-price-review.ts` + `price-review.ts`                                                                                                         | `price-review.ts`                                                                          |
| `run-discount-verification.ts` + `discount-verification.ts`                                                                                       | `discount-verification.ts`                                                                 |
| `run-price-lookup.ts` + `price-lookup.ts`                                                                                                         | `price-lookup.ts`                                                                          |
| `price-rules.ts`, `clean-median.ts` SQL fragments                                                                                                 | `store/fragments.ts`                                                                       |

### collection

| Today                          | Target                                                            |
| ------------------------------ | ----------------------------------------------------------------- |
| `listings.ts` (14 db, 416 loc) | `listings.ts` (upsert decisions) + `store/listings.ts`            |
| `queries.ts` (9 db)            | `store/dashboard.ts`                                              |
| `keywords.ts` (2 db)           | `keywords.ts` + `store/keywords.ts`                               |
| `run.ts` (260 loc, 0 db)       | `collect.ts`? name to settle in the PR: it is the collection loop |

### real-estate

`queries.ts`, `price-history.ts`, `details.ts` SQL into `store/`; `extraction.ts`, `extractor.ts` stay.

## Out of scope

- Behavior, SQL text, public exports (`index.ts`), route contracts.
- Catalog writes `listings.product_id`, a table collection owns. Same access as today; flagged, not changed here.
- `server/refreshHandlers.ts` deep-imports `src/modules/collection/browser` (Playwright owner). Existing exception, untouched.

## Migration

Tier 1 refactor PRs, behavior-preserving, one logical change per commit, `git mv` first so history follows:

1. Catalog (pilot): moves, merges, `store/` split, lint rule with baseline for the other three modules.
2. Pricing. 3. Collection. 4. Real-estate; baseline removed.

Per PR checklist (rename safety, `refactoring.md`): imports, `vi.mock` paths, string references (a comment in `src/workers/extract-products/index.ts` named `modules/catalog/run-extraction.ts`, now `run.ts`), `docs-site/` via `pnpm gen-arch-doc` (not hand-edited), knip, `tests/lint-config.test.ts`, `CONTEXT.md`.

### Sequencing

Wave 2 of the Express migration (BUY-78..82) adds `routes.ts` and `schemas.ts` and imports from `queries.ts` and `product-storage.ts`. Renames under it cause rebase churn, so this refactor starts after wave 2 merges. BUY-77 is dashboard only and unaffected.

## Alternatives considered

- **B. Suffix convention, flat** (`*.store.ts`). Fewer moves, but "no `.query(` outside" is only a filename regex, and the folder gives no visual boundary.
- **C. Entity files own their queries** (`products.ts` holds logic and SQL). Fully feature-grouped, but SQL stays scattered and unlintable, which is today's debugging problem.

## Open questions

- `store/` split granularity: per entity, per dashboard page, or per capability?
- Line hint at which a capability becomes a folder (shared config sets it; check `configs/`).
- `pricing/store/fragments.ts`: acceptable that other modules import fragments through pricing's index?
- Collection's `run.ts`: final name.
- Tickets: one per module (4), filed once accepted.
