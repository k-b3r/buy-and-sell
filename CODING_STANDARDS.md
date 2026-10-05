# Coding Standards

Project layer on top of the global [k-b3r/agent-config standards](https://github.com/k-b3r/agent-config/blob/main/CODING_STANDARDS.md): same sections and tags, only what's specific to this repo. Generic rules live there, not here. This file wins on conflict. When in doubt, match surrounding code.

## Workflow

- `process` Specs go under `docs/superpowers/specs/`.
- `tool` Canonical check: `pnpm check` (format, lint, depcruise, knip, typecheck, unit tests), run by the lefthook pre-push hook.
- `tool` CI: thin callers of `k-b3r/agent-config` `ci-typescript.yml` (`ci.yml` static + unit, `integration.yml`, `e2e.yml` with path filters; static adds `repo-checks all`, gitleaks, `docs:check`) and `pr-review.yml` (agent review, gate, `/approve`). PR upkeep: `auto-merge.yml` merges PRs labelled `automerge` (added by a human or the orchestrating session after reading the agent's report, never by the PR's own agent) once green and current; `pr-upkeep.yml` commits regenerated `docs-site/` and merges main into PRs that fall behind (`merge-conflict` label when it can't). Agents `git pull` before pushing. Shared ESLint and depcruise rules come from `@k-b3r/agent-config`; repo-specific blocks live in `eslint.config.js` / `.dependency-cruiser.cjs`. Known boundary violations, if any, are baselined in `.dependency-cruiser-known-violations.json`, with `--ignore-known` added to `pnpm depcruise` while that file exists (ratchet; each has a BUY ticket); none today.

## Architecture

```
src/platform/             shared infra (db, logger, settings, images, worker loop)
src/domains/llm-clients/  shared LLM/search clients; SDKs only in gemini-sdk.ts / groq-sdk.ts
src/modules/              feature modules (catalog, collection, pricing, real-estate), index.ts is the only public API
src/workers/              long-running loops, one folder each, entry = index.ts (wiring only)
src/utils/                one-off / backfill scripts, one folder each (wiring only)
server/                   VPS HTTP server (named-query whitelist, worker control)
dashboard/                Next.js app, thin RPC client over server/
db/schema.sql             single source of schema truth
```

- `tool` Module boundaries: ESLint + `.dependency-cruiser.cjs` (`pnpm depcruise`). Every `src/modules/*` folder is a public API automatically; heavy SDKs (Playwright, sharp/S3, pg, groq-sdk, @google/genai) load only from their owner file.
- `tool` Entry points stay thin: `max-lines` and `complexity` are errors (not hints) for `src/workers/*/index.ts`, `src/utils/*/index.ts` and `server/routes/*` (`eslint.config.js`, covered by `tests/lint-config.test.ts`).

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
- `review` No direct DB access: all SQL lives in the modules' `queries.ts` (settings in `src/platform/settings.ts`) behind the named-query whitelist in `server/routes/query.ts`.
- `review` Data pages are `force-dynamic` (no build-time dependency on the VPS).

## Data

- `review` ₱/sqm and similar ratios are derived at query time, never stored.
