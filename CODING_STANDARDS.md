# Coding Standards

Rules distilled from how this repo is actually written plus standing preferences. When in doubt, match surrounding code.

## Process

- TDD by default: red, green, refactor. Every module gets a sibling `*.test.ts`.
- Low ceremony. Design in conversation, implement directly, commit. Write a spec under `docs/superpowers/specs/` only when the design has real ambiguity. Full plans and multi-agent review only for large, parallel, or risky work.
- Never commit a broken build or failing tests. Never `--no-verify`, never force-push `main`.
- When stuck after 3 attempts: stop, write down what failed, ask.
- New behavior is gated and defaults to today's behavior (e.g. `collect.re_keywords_enabled = 0`). Shipping a feature must not disrupt existing flows.

## Commits

- Imperative, lowercase, concise, no trailing period: `add real estate page`, `fix reviewed products resurfacing in needs-review queue`.
- One logical change per commit. Feature branches merge with `merge <branch>`.
- No AI co-author trailers or "generated with" lines.
- Never hand-edit generated files (lockfiles, CHANGELOG, `DO NOT EDIT` files). Change the source, rerun the generator.

## TypeScript

- `strict: true`, ES modules, `tsx` to run, Vitest (globals) to test.
- No semicolons, single quotes, 2-space indent, trailing commas in multiline literals.
- `import type` for type-only imports, kept on separate lines from value imports.
- `unknown` over `any`. Narrow external data explicitly (`typeof item?.id === 'string' ? ... : null`).
- Named exports. Domain folders expose a barrel `index.ts` (`export * from './x'`).
- Tunables as `UPPER_SNAKE` constants at top of file (`MAX_ATTEMPTS`, `RETRY_DELAY_MS`). Runtime-adjustable ones live in DB settings with a `SETTING_DEFAULTS` fallback.
- Custom error subclasses for control flow that must unwind (`class QuotaExhaustedError extends Error {}`).

## Structure

```
src/platform/   shared infra (db, logger, settings, utils)
src/domains/    pure-ish domain logic + external clients (marketplace, llm-clients)
src/workers/    long-running loops, one folder each, entry = index.ts
src/utils/      one-off / backfill scripts, one folder each
server/         VPS HTTP server (named-query whitelist, worker control)
dashboard/      Next.js app, thin RPC client over server/
db/schema.sql   single source of schema truth
```

- Every worker/util gets a `package.json` script (`pnpm extract-real-estate`).
- Keep domain logic out of workers: workers wire dependencies and loop, domains decide.

## Testability

- Inject dependencies as params: `DbClient`, `Logger`, `DelayFn`, LLM clients. No hidden singletons.
- Interfaces stay minimal (`DbClient` is one `query` method) so tests mock with a few lines.
- Real sleeps go through `realDelay`; tests pass a no-op delay.
- Test names are full sentences describing behavior: `'loadSettings falls back to SETTING_DEFAULTS for a key missing from the table'`.
- Assert on SQL shape and params where the query itself is the contract.

## Comments

- Explain _why_, not _what_. Include evidence and date when a choice came from a live observation (`Confirmed live 2026-09-24: ...`).
- Cross-reference sibling code that follows the same rule instead of re-explaining (`same rule as the sub-category backfill`).
- No comments on obvious code.

## Resilience

- External calls retry with bounded attempts and delay, then degrade (halve the batch, skip the item) instead of crashing the run.
- Distinguish fatal (429 quota) from transient errors. Fatal unwinds, transient retries.
- Log every skip or degradation with id and reason. Never lose data silently: unprocessed items stay candidates for the next lap.

## External services

- Be a polite, low-volume client. Pace requests against rate-sensitive targets (Facebook): no rapid ad-hoc probing, batch checks into one run.
- Respect robots.txt and ToS. Don't scrape sources that forbid it.
- ₱0 budget default: prefer free tiers, self-hosting, and round-robin keys over paid services.

## Dashboard

- Read Next.js docs in `node_modules/next/dist/docs/` before writing code (version differs from training data).
- No direct DB access: all SQL lives in `server/queries.ts` behind the named-query whitelist.
- Data pages are `force-dynamic` (no build-time dependency on the VPS).

## Data

- Derive at query time instead of storing (e.g. ₱/sqm). Store raw inputs.
- Feature-specific data goes in side tables (1:1, cascade delete) rather than widening core tables.
- Diagnose with real data before deciding. Prefer LLM per-item passes over brittle heuristics for fuzzy classification.
