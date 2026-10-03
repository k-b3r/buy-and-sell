# Architecture cleanup plan

Goal: move from layer folders (`src/domains/marketplace/` grab-bag, `src/domains/*/storage/`, one 1900-line `server/queries.ts`) to feature modules, per `CONTEXT.md` > Architecture. Tracked on the Linear **BUY** board, one ticket = one PR.

Rules for every ticket:

- Refactor only (no behavior change) unless the ticket says otherwise. Tests green before and after; behavior changes go in separate commits.
- Each module: `src/modules/<name>/` with `index.ts` as its only public API (explicit exports), logic + storage SQL + dashboard queries inside, sibling unit tests.
- `dependency-cruiser` gets a rule per module as it lands: outside callers use only its `index.ts`; no cycles.
- Small steps, `pnpm check` on each commit, stacked PRs when a ticket depends on an unmerged one.

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

| #   | Title                                 | Scope                                                                                                                                                                                                                                                                           | Done when                                                                              | Depends                                      |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------- |
| 0   | Merge CI stack                        | PRs #1 -> #3 -> #4 -> #5 on k-b3r/buy-and-sell-ai                                                                                                                                                                                                                               | All merged to main, CI green incl. agent review                                        | `CLAUDE_CODE_OAUTH_TOKEN` repo secret (user) |
| 1   | Record architecture decision          | `CONTEXT.md` > Architecture + this plan                                                                                                                                                                                                                                         | Merged                                                                                 | none                                         |
| 2   | Extract real-estate module            | `src/domains/marketplace/real-estate.ts`, `storage/real-estate.ts`, real-estate parts of `storage/listings.ts` (price history), `getRealEstateListings` + filters from `server/queries.ts` -> `src/modules/real-estate/`; worker + server import its `index.ts`; depcruise rule | Module has no importers of internals; `pnpm check` + integration green                 | 0                                            |
| 3   | Split `server/queries.ts` by module   | Each module exports its dashboard queries; `server/routes/query.ts` REGISTRY assembled from them; shared helpers to `platform/`                                                                                                                                                 | `server/queries.ts` gone or under ~200 lines of cross-cutting helpers                  | 2                                            |
| 4   | Pricing module + dedupe pricing rules | Arch review 2026-09-03 #1 (price lookup duplicated), #4 (clean median ~6x), #5 (repost dedup JS + SQL), #6 (3 `price_lookup_excluded` writers) -> one owner each in `src/modules/pricing/`                                                                                      | Each rule has one implementation, tests cover it; old copies deleted                   | 3                                            |
| 5   | Shared LLM provider fallback          | Arch review #2 + #3: one fallback/round-robin implementation in `platform/llm-clients`, providers plug in                                                                                                                                                                       | 4 copies of the loop gone; provider tests green                                        | 0                                            |
| 6   | Catalog module                        | products, extraction, enrichment, categories, merge/generic/mismatch -> `src/modules/catalog/`                                                                                                                                                                                  | `src/domains/marketplace/` holds only collection code                                  | 4                                            |
| 7   | Collection module                     | browser, proxy, tunnel, paginate, wall, extract/grid+detail, listing upsert/recheck -> `src/modules/collection/`; arch review #7 (`defaultDriverFactory` dup)                                                                                                                   | `src/domains/` deleted; Playwright still reachable only via collection's browser entry | 6                                            |

Order: 0, 1 -> 2 -> 3 -> 4 -> 6 -> 7; 5 can run any time after 0.

Out of scope: repo split for real estate (see CONTEXT.md triggers), dashboard restructure (follows Next.js conventions), behavior changes found along the way (file as separate BUY tickets).
