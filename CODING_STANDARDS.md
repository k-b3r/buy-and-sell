# Coding Standards

Project layer on top of the global [k-b3r/agent-config standards](https://github.com/k-b3r/agent-config/blob/main/CODING_STANDARDS.md): same sections and tags, only what's specific to this repo. Generic rules live there, not here. This file wins on conflict. When in doubt, match surrounding code.

## Workflow

- `process` Specs go under `docs/superpowers/specs/`.
- `tool` Canonical check: `pnpm check` (format, lint, depcruise, knip, typecheck, unit tests), run by the lefthook pre-push hook.
- `tool` CI: thin callers of `k-b3r/agent-config` `ci-typescript.yml` (`ci.yml` static + unit, `integration.yml`, `e2e.yml` with path filters; static adds `repo-checks all`, gitleaks, `docs:check`) and `pr-review.yml` (agent review, gate, `/approve`). Shared ESLint and depcruise rules come from `@k-b3r/agent-config`; repo-specific blocks live in `eslint.config.js` / `.dependency-cruiser.cjs`. Known boundary violations are baselined in `.dependency-cruiser-known-violations.json` (ratchet; each has a BUY ticket).

## Architecture

```
src/platform/   shared infra (db, logger, settings, utils)
src/domains/    pure-ish domain logic + external clients (marketplace, llm-clients)
src/workers/    long-running loops, one folder each, entry = index.ts
src/utils/      one-off / backfill scripts, one folder each
server/         VPS HTTP server (named-query whitelist, worker control)
dashboard/      Next.js app, thin RPC client over server/
db/schema.sql   single source of schema truth
```

- `tool` Module boundaries: ESLint + `.dependency-cruiser.cjs` (`pnpm depcruise`).

## Design

- `review` New behavior is gated behind a DB setting that defaults to today's behavior (e.g. `collect.re_keywords_enabled = 0`).

### Structure

- `review` Every worker/util gets a `package.json` script (`pnpm extract-real-estate`).

## Writing Code

- `review` Runtime-adjustable tunables live in DB settings with a `SETTING_DEFAULTS` fallback (`src/platform/settings.ts`).

## Testing

- `review` Injected deps: `DbClient` (one `query` method), `Logger`, `DelayFn`, LLM clients.
- `tool` Real sleeps go through `realDelay`. _(ESLint)_

## External Services

- `process` Facebook is rate-sensitive: pace live verification, never fire quick-succession test scripts.

## Dashboard

- `process` Read Next.js docs in `node_modules/next/dist/docs/` before writing code (version differs from training data).
- `review` No direct DB access: all SQL lives in `server/queries.ts` behind the named-query whitelist.
- `review` Data pages are `force-dynamic` (no build-time dependency on the VPS).

## Data

- `review` ₱/sqm and similar ratios are derived at query time, never stored.
