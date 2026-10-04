# Architecture cleanup plan

Goal: move from layer folders (`src/domains/marketplace/` grab-bag, `src/domains/*/storage/`, one 1900-line `server/queries.ts`) to feature modules, per `CONTEXT.md` > Architecture. Tracked on the Linear **BUY** board, one ticket = one PR.

Rules for every ticket:

- Refactor only (no behavior change) unless the ticket says otherwise. Tests green before and after; behavior changes go in separate commits.
- Each module: `src/modules/<name>/` with `index.ts` as its only public API (explicit exports), logic + storage SQL + dashboard queries inside, sibling unit tests.
- `dependency-cruiser` gets each module as it lands: add it to `publicApis` (outside callers use only its `index.ts`) and `inner` in `.dependency-cruiser.cjs`; no cycles.
- Small steps, `pnpm check` on each commit, stacked PRs when a ticket depends on an unmerged one.

Design rules applied while moving code (global standards > Design, added 2026-10-05):

- Entry points wire, modules decide: decision logic moves out of workers and utils into the module; workers keep env, deps, the loop. Today `extract-products` (417 lines), `collect` (262) and `enrich-products` (243) hold logic.
- Functional core, imperative shell: moved logic splits into pure functions (data in, data out) plus a thin I/O shell. Audit candidates: `price-lookup.ts`, `discount-verification.ts`, `storage/listings.ts` (832 lines).
- Inject only I/O (db, logger, delay, LLM and browser clients), wired once per entry point; env read only there (ESLint `entryPoints`).
- Every moved file keeps or gains a sibling test (`repo-checks untested-modules` ratchet).
- Heavy deps stay out of each module's `index.ts` (`index-stays-light`); known violations live in `.dependency-cruiser-known-violations.json` and shrink, never grow.

## Target layout

```
src/modules/
  collection/    browser, proxy/tunnel, pagination, wall detection, listing upsert/recheck
  catalog/       product extraction, enrichment, categories, dedup/merge, generic/mismatch detection
  pricing/       price lookup (retail + secondhand), price review, clean median, discounts, notifications
  real-estate/   extraction prompt/normalize, real_estate_details storage, listings + review queries
src/platform/    db, logger, settings, images, delay/env utils, llm-clients (shared infra, no feature logic)
src/workers/     entry points: wire deps + loop only
src/utils/       one-off scripts: wire deps + call modules only
server/          HTTP, auth, named-query registry assembled from modules' query exports
```

## Tickets

| #   | Title                                                    | Scope                                                                                                                                                                                                                                                                           | Done when                                                                              | Depends                                      |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------- |
| 0   | Merge CI stack                                           | PRs #1 -> #3 -> #4 -> #5 on k-b3r/buy-and-sell-ai                                                                                                                                                                                                                               | All merged to main, CI green incl. agent review                                        | `CLAUDE_CODE_OAUTH_TOKEN` repo secret (user) |
| 1   | Record architecture decision                             | `CONTEXT.md` > Architecture + this plan                                                                                                                                                                                                                                         | Merged                                                                                 | none                                         |
| 2   | Extract real-estate module                               | `src/domains/marketplace/real-estate.ts`, `storage/real-estate.ts`, real-estate parts of `storage/listings.ts` (price history), `getRealEstateListings` + filters from `server/queries.ts` -> `src/modules/real-estate/`; worker + server import its `index.ts`; depcruise rule | Module has no importers of internals; `pnpm check` + integration green                 | 0                                            |
| 3   | Split `server/queries.ts` by module                      | Each module exports its dashboard queries; `server/routes/query.ts` REGISTRY assembled from them; shared helpers to `platform/`                                                                                                                                                 | `server/queries.ts` gone or under ~200 lines of cross-cutting helpers                  | 2                                            |
| 4   | Pricing module + dedupe pricing rules                    | Arch review 2026-09-03 #1 (price lookup duplicated), #4 (clean median ~6x), #5 (repost dedup JS + SQL), #6 (3 `price_lookup_excluded` writers) -> one owner each in `src/modules/pricing/`                                                                                      | Each rule has one implementation, tests cover it; old copies deleted                   | 3                                            |
| 5   | Shared LLM provider fallback                             | Arch review #2 + #3: one fallback/round-robin implementation in `platform/llm-clients`, providers plug in                                                                                                                                                                       | 4 copies of the loop gone; provider tests green                                        | 0                                            |
| 6   | Catalog module                                           | products, extraction, enrichment, categories, merge/generic/mismatch -> `src/modules/catalog/`                                                                                                                                                                                  | `src/domains/marketplace/` holds only collection code                                  | 4                                            |
| 7   | Collection module                                        | browser, proxy, tunnel, paginate, wall, extract/grid+detail, listing upsert/recheck -> `src/modules/collection/`; arch review #7 (`defaultDriverFactory` dup)                                                                                                                   | `src/domains/` deleted; Playwright still reachable only via collection's browser entry | 6                                            |
| 8   | Inject env into server proxyGuard (BUY-22)               | `server/proxyGuard.ts` env read moves to `server/index.ts`; drop its ESLint `entryPoints` exemption                                                                                                                                                                             | No `process.env` outside entry points in `server/`                                     | 0                                            |
| 9   | Inject test-run flag (BUY-25)                            | `isTestRun` env read moves to `check-listings` entry; drop `src/platform/utils.ts` exemption                                                                                                                                                                                    | No `process.env` in `src/platform/`                                                    | 0                                            |
| 10  | Keep sharp and S3 out of the marketplace barrel (BUY-26) | Inject photo storage functions or move them behind collection's own entry                                                                                                                                                                                                       | Baseline entry gone, `pnpm depcruise` green without it                                 | 0; fits 7                                    |
| 11  | Move domain logic out of utils scripts (BUY-23)          | `merge-duplicate-products`, category backfills -> catalog; `flag-price-ineligible`, `price-from-listings` -> pricing; utils keep wiring only                                                                                                                                    | Each util entry is wiring only; moved rules tested in their module                     | 4, 6                                         |

Order: 0, 1 -> 2 -> 3 -> 4 -> 6 -> 7; 11 after 4 and 6; 5, 8, 9, 10 any time after 0 (10 may fold into 7). Linear: 0 BUY-5, 1 BUY-6, 2 BUY-7, 3 BUY-9, 4 BUY-10, 5 BUY-8, 6 BUY-11, 7 BUY-12.

Out of scope: repo split for real estate (see CONTEXT.md triggers), dashboard restructure (follows Next.js conventions), behavior changes found along the way (file as separate BUY tickets).
