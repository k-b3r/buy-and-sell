# Coding Standards

Project layer on top of the global [k-b3r/agent-config standards](https://github.com/k-b3r/agent-config/blob/main/CODING_STANDARDS.md): same sections and tags, only what's specific to this repo. Generic rules live there, not here. This file wins on conflict. When in doubt, match surrounding code.

## Workflow

- `process` Specs go under `docs/specs/`.
- `tool` Canonical check: `pnpm check`, run by the lefthook pre-push hook.
- `tool` CI: thin callers of `k-b3r/agent-config` workflows (`.github/workflows/`). `auto-merge.yml` merges PRs labelled `automerge` (added by a human or the orchestrating session after reading the agent's report, never by the PR's own agent) once green and current; `pr-upkeep.yml` commits regenerated `docs-site/` and merges main into PRs that fall behind (`merge-conflict` label when it can't). Agents `git pull` before pushing. Known boundary violations are baselined in `.dependency-cruiser-known-violations.json`, with `--ignore-known` added to `pnpm depcruise` while that file exists (ratchet; each has a BUY ticket).

## Architecture

- `tool` Module boundaries: ESLint + `.dependency-cruiser.cjs` (`pnpm depcruise`). Every `src/modules/*` folder is a public API automatically; heavy SDKs (Playwright, sharp/S3, pg, groq-sdk, @google/genai) load only from their owner file.
- `tool` Module tiers (`moduleTiers` in `.dependency-cruiser.cjs`): a `src/modules/*` module imports only modules in lower tiers, never its own tier, and only through its `index.ts`. Order, lowest first: `real-estate`, `pricing`, `catalog`, `collection`. The order follows the real imports: `catalog` and `collection` read pricing, and `collection` reads real-estate, while `real-estate` and `pricing` import no module. Code two modules share goes down to `src/platform` (e.g. `product-id.ts`), not sideways. A new module must be added to the tier list or `pnpm depcruise` fails.
- `review` Module layout: `index.ts` (public API and public types only), `types.ts` (types and ports the module's own files share, not row types; types only, no runtime code, so exempt from the untested-module ratchet by default), `domain/` (pure code), `app/` (use cases: fetch via store, decide with domain, act), `store/` (SQL and row types), `clients/` (external adapters carrying domain types), `prompts/` (what the module sends an LLM, one file per job: the prompt prose first, then the helpers that interpolate data, then the response schema). Add folders as files grow; a small module stays flat but keeps `domain/` for pure code. `routes.ts` and the request-parsing `schemas.ts` stay at the module root as the HTTP edge. Tests sit beside the file they test. `real-estate` is the reference.
- `tool`+`review` Pure code lives in `src/modules/*/domain/**` and `src/modules/*/prompts/**` (`pureCorePaths`): no clock, randomness, `fetch` or `process` _(ESLint)_; no DB, logger or imports of `store/`, `clients/` or `app/`, and entry points reach a module only through its `index.ts` (or `routes.ts` from `server/`) _(`.dependency-cruiser.cjs`, `domain-no-effects` and `entries-through-module-api`; intent still review)_. Every module is store-only for SQL and has no exported `run*` loops _(ESLint, `src/modules/**`)_.
- `review` Each module has a short `README.md`: purpose, tables owned, "must never" rules. Nothing the code already shows (no API list, no layer list, no tier).
- `tool` Entry points stay thin: `max-lines` and `complexity` are errors (not hints) for `src/workers/*/index.ts`, `src/utils/*/index.ts` and `server/routes/*` (`eslint.config.js`, covered by `tests/lint-config.test.ts`).

## Design

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

- `review` No direct DB access: all SQL lives in the modules' `store/` folders (settings in `src/platform/settings.ts`), exposed only through the modules' `routes.ts` routers that `server/index.ts` mounts (the dashboard calls them with `dashboard/src/lib/api.ts`).

## Data

- `review` ₱/sqm and similar ratios are derived at query time, never stored.
