# Session Resume

Updated 2026-10-03. Read this, then `docs/architecture-cleanup-plan.md` and `CONTEXT.md` > Architecture.

## Start here (fresh session)

1. **Create Linear tickets** on the **BUY** board from the Tickets table in `docs/architecture-cleanup-plan.md` (tickets 0-7): title, scope, done-when, and blocked-by links matching the Depends column. Linear MCP is registered user-scope (`claude mcp get linear`); claude.ai connectors are off for this repo on purpose, the direct MCP is separate.
2. **Ticket 0 (merge CI stack)** needs the user to add the repo secret first:
   `claude setup-token` then `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo k-b3r/buy-and-sell-ai`.
   Then merge in order: #1 (`add-ci` -> main), #3 (`ci-lint-gates`), #4 (`module-boundaries`), #5 (`ci-hygiene-gates`). Each is stacked on the previous; after merging one, retarget the next to `main`.
3. **Ticket 2 (real-estate module)** is the first refactor once 0 lands.

## State

- **Open PRs (all CI green except agent-review/gate, blocked on the secret):**
  - #1 `add-ci`: prettier, eslint, typecheck, unit/integration (real Postgres)/e2e (Playwright) jobs, agent PR review. Tests live in `tests/integration/` and `tests/e2e/`.
  - #3 `ci-lint-gates`: bans `@ts-ignore`/`any`, disable comments need `-- reason`, no `process.env` in `src/domains/**`, no inline sleeps; lint config tested by `tests/lint-config.test.ts` + fixtures.
  - #4 `module-boundaries`: explicit marketplace `index.ts` (no `export *`), Playwright only via `domains/marketplace/browser.ts`, `.dependency-cruiser.cjs` (8 rules, each mutation-tested), `pnpm depcruise`.
  - #5 `ci-hygiene-gates`: knip, `pnpm docs:check` (generated arch docs drift), `scripts/repo-checks.ts` (commit subjects, escape-hatch count vs base), lefthook pre-push `pnpm check`.
- Worktree `.claude/worktrees/add-ci` is on `ci-hygiene-gates`; remove after the stack merges.
- `pnpm check` = format, lint, depcruise, knip, typecheck, unit tests (~55s). Pre-push hook runs it; `LEFTHOOK=0` bypasses deliberately.

## Conventions

- GitHub account **k-b3r**. `origin` is HTTPS: run `gh auth switch -u k-b3r` in the same command as any push/gh call (active account flips to kimbermudez). Switching `origin` to SSH is an open item.
- Every change via PR, merge only when CI green. Merge commit subject: `merge <branch>`.
- Standards: global `~/.claude/CODING_STANDARDS.md` (k-b3r/agent-config, rules tagged tool/hint/review/process) + this repo's `CODING_STANDARDS.md`. New unclear-shape features use `/spike-and-rebuild`.
- CodeGraph MCP is installed user-scope; this repo is **not indexed** yet (`codegraph init` + `.codegraph/` in `.gitignore` is the user's call).

## Open items (not in the cleanup plan)

- Switch `origin` to SSH (`git@github.com:k-b3r/buy-and-sell-ai.git`).
- `AGENT_CONFIG_TOKEN` (read-only PAT) secret so CI agent review can read the global standards.
- Patterns + DI rules for global standards (prefer functional core / imperative shell, composition root, adapters at boundaries, strategy as plain functions, idempotent ops; avoid inheritance, singletons, one-impl interfaces, event buses, DI containers; "inject only I/O, pure logic takes data"; interfaces only at I/O boundaries).
- Global standards name `commitlint`; repo uses `scripts/repo-checks.ts` instead (commitlint expects `type:` prefixes). Align the wording.
- Measure CodeGraph's effect: rerun the 3 baseline agent tasks with the repo indexed and compare tokens (baseline: ~35k fixed startup context, 55-67k peak per task).

## Older product follow-ups (from 2026-09-02, unverified since)

- Est. days-to-sell query (median `sold_at - listed_at` per product); `/deals` shows a placeholder.
- `saved_listings` outcome columns (bought/sold/actual profit) once `/deals` has usage.
- `/deals` <-> `discount_notifications` "already flagged" badge.
- `verify-discount-notifications` backlog grows faster than the 3/lap cap drains.
- Catalog-wide audit for wrong-model product mismatches (title model number vs product `base_model`).
