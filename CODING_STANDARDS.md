# Coding Standards

Project layer on top of the global [k-b3r/agent-config standards](https://github.com/k-b3r/agent-config/blob/main/CODING_STANDARDS.md): same sections and tags, only what's specific to this repo. Generic rules live there, not here. This file wins on conflict. When in doubt, match surrounding code.

## Workflow

- `process` Specs go under `docs/specs/`.
- `tool` Canonical check: `pnpm check`, run by the lefthook pre-push hook.
- `tool` CI: thin callers of `k-b3r/agent-config` workflows (`.github/workflows/`). `auto-merge.yml` merges PRs labelled `automerge` (added by a human or the orchestrating session after reading the agent's report, never by the PR's own agent) once green and current; `pr-upkeep.yml` commits regenerated `docs-site/` and merges main into PRs that fall behind (`merge-conflict` label when it can't). Agents `git pull` before pushing. Known boundary violations are baselined in `.dependency-cruiser-known-violations.json`, with `--ignore-known` added to `pnpm depcruise` while that file exists (ratchet; each has a BUY ticket).

## Architecture

- `tool` Module boundaries: ESLint + `.dependency-cruiser.cjs` (`pnpm depcruise`). Every `src/modules/*` folder is a public API automatically; heavy SDKs (Playwright, sharp/S3, pg, groq-sdk, @google/genai) load only from their owner file.
- `tool` Entry points stay thin: `max-lines` and `complexity` are errors (not hints) for `src/workers/*/index.ts`, `src/utils/*/index.ts` and `server/routes/*` (`eslint.config.js`, covered by `tests/lint-config.test.ts`).

## Design

- `review` New behavior is gated behind a DB setting that defaults to today's behavior (e.g. `collect.re_keywords_enabled = 0`).

### Structure

- `review` Every worker/util gets a `package.json` script (`pnpm extract-real-estate`).

## Writing Code

- `tool`+`review` Runtime-adjustable tunables live in DB settings with a `SETTING_DEFAULTS` fallback (`src/platform/settings.ts`). _(`tests/settings-wiring.test.ts` checks every setting is seeded and in the dashboard catalog; whether a value is a tunable is review)_

## Testing

- `review` Injected deps: `DbClient` (one `query` method), `Logger`, `DelayFn`, LLM clients.
- `tool` Real sleeps go through `realDelay`. _(ESLint)_

## External Services

- `process` Facebook is rate-sensitive: pace live verification, never fire quick-succession test scripts.

## Dashboard

- `review` No direct DB access: all SQL lives in the modules' `queries.ts` (settings in `src/platform/settings.ts`) behind the named-query whitelist in `server/routes/query.ts`.
- `tool`+`review` Data pages are `force-dynamic` (no build-time dependency on the VPS). _(`tests/pages-dynamic.test.ts` checks every page importing `queries` or `cachedQueries`; which pages count as data pages is review)_

## Data

- `review` ₱/sqm and similar ratios are derived at query time, never stored.
