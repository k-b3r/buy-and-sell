# Coding Standards

Project-specific rules. General rules (TDD, TypeScript style, testability, comments, resilience) live in [k-b3r/agent-config](https://github.com/k-b3r/agent-config/blob/main/CODING_STANDARDS.md); this file wins on conflict. When in doubt, match surrounding code.

## Process

- Write specs under `docs/superpowers/specs/` only when the design has real ambiguity.
- Gate new behavior behind a DB setting that defaults to today's behavior (e.g. `collect.re_keywords_enabled = 0`).

## Commits

- Examples: `add real estate page`, `fix reviewed products resurfacing in needs-review queue`.
- Feature branches merge with `merge <branch>`.

## Tooling

- `tsx` to run, Vitest (globals) to test. Every module gets a sibling `*.test.ts`.
- Runtime-adjustable tunables live in DB settings with a `SETTING_DEFAULTS` fallback (`src/platform/settings.ts`).

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

## Testability

- Injected deps: `DbClient` (one `query` method), `Logger`, `DelayFn`, LLM clients.
- Real sleeps go through `realDelay`.

## External services

- Facebook is rate-sensitive: pace live verification, never fire quick-succession test scripts.

## Dashboard

- Read Next.js docs in `node_modules/next/dist/docs/` before writing code (version differs from training data).
- No direct DB access: all SQL lives in `server/queries.ts` behind the named-query whitelist.
- Data pages are `force-dynamic` (no build-time dependency on the VPS).

## Data

- ₱/sqm and similar ratios are derived at query time, never stored.
