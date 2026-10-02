# Interfaces and Agent Token Usage

Sources:
- Anthropic, Effective context engineering for AI agents: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Coding agents as a first-class consideration in project structures: https://dev.to/somedood/coding-agents-as-a-first-class-consideration-in-project-structures-2a6b
- Token optimization for coding agents (Sombra): https://sombrainc.com/blog/token-optimization
- Deep modules for agents (AI Hero): https://aihero.dev/s/QmBEIh

Does working against interfaces cut agent token usage? Partly. The claims below are reasoning backed by the sources' general principles, not measured on this repo.

## Background

- Anthropic's goal for context: the smallest set of high-signal tokens. Long noisy context degrades accuracy, not just cost.
- Claude Code retrieves just in time: CLAUDE.md loads up front, then glob/grep/read pull files on demand. Code layout decides how much gets pulled.
- Every tool result stays in context for the rest of the session, so each unnecessary file read costs tokens on every later turn.

## Where interfaces save tokens

- Consuming a module without opening it: if name, signature, types, and a one-line doc settle behavior, the agent calls it and skips the body.
- Refactors stay local: behavior-level tests don't change when internals change, so no test read/rewrite/rerun loop. That loop is usually the bigger sink.
- Smaller search surface: a narrow public API means fewer files to grep and open.

## Where they don't

- Agents read whole files. Interface and body in one file means reading the signature loads the body. Savings need separation: small `index.ts` with just the public API, types and exports at the top, or small files.
- `export *` barrels hide the API, so the agent opens every file behind them. (`src/domains/marketplace/index.ts` re-exports 18 files.)
- Ambiguous interfaces get read anyway: if it's unclear whether a function retries, throws, or writes to the DB, the agent opens the body to be sure.
- Changing internals still needs the internals. Savings apply to tasks that use a module, not tasks that modify it.

## Candidate rules

- ⚠️ Barrels export an explicit, minimal public API. No `export *`.
- ⚠️ Each export gets a one-line comment covering side effects and failure modes (retries? throws? writes DB?).
- ⚠️ Public types and exported functions at the top of the file, helpers below.
- ✅ Keep `CONTEXT.md` current so the agent reads definitions instead of searching code.
- ⚠️ Keep files cohesive and colocated so one read gets all relevant code, and nothing unrelated.
