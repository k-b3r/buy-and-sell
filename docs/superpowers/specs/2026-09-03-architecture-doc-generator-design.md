# Architecture Doc Generator — Design

**Status:** draft, pending review.

**Goal:** a single, always-current markdown document that maps the whole app —
domains, modules, exported functions/classes (signature + description), and
which modules call/import which — so the app's design can be understood
without re-reading every file. Regenerated automatically on every commit that
touches `src/`, `server/`, or `dashboard/src/`, so it can never go stale and
silently mislead.

**Scope: three projects.** `src/` (collector/worker scripts), `server/`
(Express-style API, own `tsconfig.json`/`package.json`), and `dashboard/src/`
(Next.js app, own `tsconfig.json`/`package.json`, `.tsx` included) are
independent TypeScript projects. The generator runs once per project (three
`ts-morph` `Project` instances, one per `tsconfig.json`) and the output doc
gets one more nesting level on top of domain: **Project → Domain → Module →
Function**.

## Why this scope, why now

The codebase is functional-style (`src/workers`, `src/utils`, `src/domains/*`,
`src/platform`) — only one file uses `class`. There is no existing map of how
these ~20+ worker/util scripts and domain modules relate. Direct discussion
landed on: node granularity = domain → module → function (classes included
where they exist), rendered as one nested doc (not separate diagrams), with
function descriptions sourced from JSDoc — not invented.

Because JSDoc is currently sparse, build order matters: build the generator
first so its first run produces a checklist of every exported function
missing a description, backfill JSDoc against that checklist, then wire the
pre-commit hook once the doc is actually complete (not before — an
auto-committed doc full of blanks isn't more useful than no doc).

## Architecture

```
scripts/gen-arch-doc.ts (ts-morph, run via tsx)
  -> load tsconfig.json, walk all source files under src/
  -> group by domain (top-level folder under src/: workers, utils, platform,
     domains/<sub>) then by module (file) within domain
  -> per module: extract exported function/class declarations
       - signature (params + return type)
       - JSDoc summary (blank + flagged "_(undocumented)_" if absent)
       - import edges to other in-repo modules ("Interactions")
  -> render nested markdown -> docs/ARCHITECTURE.md
       |
       v
.git/hooks/pre-commit (added only after backfill is complete)
  -> runs gen-arch-doc.ts, `git add docs/ARCHITECTURE.md`
  -> non-zero exit (parse error, etc.) aborts the commit
```

## 1. Generator — `scripts/gen-arch-doc.ts`

```ts
interface ExtractedFunction {
  name: string
  signature: string        // e.g. "(db: DbClient, id: number): Promise<void>"
  description: string | null
  isClass: boolean
}

interface ExtractedModule {
  path: string              // e.g. "src/workers/enrich-products/index.ts"
  functions: ExtractedFunction[]
  imports: string[]         // in-repo module specifiers this file imports
}

interface ExtractedDomain {
  name: string               // e.g. "workers", "domains/marketplace"
  modules: ExtractedModule[]
}

interface ExtractedProject {
  name: string                // "src" | "server" | "dashboard"
  domains: ExtractedDomain[]
}

function extractArchitecture(project: Project, rootDir: string, domainOf: (relPath: string) => string): ExtractedDomain[]
function renderMarkdown(projects: ExtractedProject[]): string
```

Runs once per project, each its own `ts-morph` `Project` instance loaded from
that project's `tsconfig.json` (root `tsconfig.json` for `src`,
`server/tsconfig.json` for `server`, `dashboard/tsconfig.json` for
`dashboard`), source files filtered to that project's target root (`src/`,
`server/`, `dashboard/src/` respectively — `dashboard`'s own `tsconfig.json`
`include` is broader than that, so filter explicitly rather than relying on
it). For each source file: iterate exported declarations via
`getExportedDeclarations()`, keep function/class/const-arrow-function
declarations, skip type-only exports (interfaces/types — noise for this doc,
already visible in the code itself) and skip `*.test.ts`/`*.test.tsx` files
entirely. Signature = declaration's `getText()` for the parameter list +
return type, trimmed to one line. Description = the declaration's leading
JSDoc comment's summary line via `getJsDocs()[0]?.getDescription()`, `null` if
absent.

Imports: `sourceFile.getImportDeclarations()`, keep only relative/in-repo
specifiers (skip `node:*`, npm packages) — these become the "Interactions"
line under each module.

Domain grouping is per-project, same underlying rule (first path segment is
the domain, except a segment that's itself a container of unrelated
sub-features takes one more segment):

- **src**: first segment after `src/` (`workers`, `utils`, `platform`); for
  `domains/`, second segment too (`domains/marketplace`, `domains/llm-clients`).
- **server**: flat — one domain, `server`, covering every file including
  `routes/*.ts` (only ~20 files total, doesn't need splitting).
- **dashboard**: first segment after `dashboard/src/` (`lib`); for `app/`
  (Next.js app-router — routes, api handlers, pages, all unrelated to each
  other), second segment too, but only when that second segment is itself a
  folder (`app/api`, `app/admin`, `app/deals`, etc.) — a loose file directly
  under `app/` (e.g. `app/BackIcon.tsx`) stays grouped under the plain `app`
  domain instead of becoming its own one-file domain. Mirrors the `domains/`
  rule in src (same loose-file carve-out applies there too).

`*.test.ts`/`*.test.tsx` files are excluded from extraction — tests aren't
part of the design surface this doc maps; skipping them cuts real noise
(`server/` in particular is close to 1:1 file-to-test-file).

## 2. Output format — `docs/ARCHITECTURE.md`

```markdown
# Architecture

_Generated by `scripts/gen-arch-doc.ts` — do not hand-edit._

## src

### workers

#### src/workers/enrich-products/index.ts

**Interactions:** imports `src/domains/marketplace/storage/products.ts`,
`src/domains/llm-clients/groq.ts`

##### enrichProduct(product: Product, clients: EnrichmentClients): Promise<EnrichmentResult>

Runs one product through the Groq enrichment pass and persists the result.

##### main(): Promise<void>

_(undocumented)_

## server

### server

#### server/routes/refreshJob.ts

...

## dashboard

### app/api

#### dashboard/src/app/api/deals/route.ts

...
```

Header nesting: `##` project, `###` domain, `####` module (path relative to
repo root), `#####` function signature. "Interactions" is a flat list of
imported in-repo module paths, sorted, deduped. Functions listed in
source-file declaration order.

## 3. Backfill pass (manual, between generator build and hook wiring)

1. Run `scripts/gen-arch-doc.ts` once against `src/`, `server/`, and
   `dashboard/src/`.
2. Every `_(undocumented)_` marker in the output is a to-do: add a one-line
   JSDoc summary comment above that declaration in the source file.
3. Re-run generator, confirm zero `_(undocumented)_` markers remain (or the
   remainder is deliberately accepted — e.g. trivial `main()` entry points).

No tooling enforces this pass; it's a manual sweep using the generated doc as
the checklist.

## 4. Pre-commit hook — `.git/hooks/pre-commit`

Added only after step 3 is done. Plain shell:

```sh
#!/bin/sh
npx tsx scripts/gen-arch-doc.ts || exit 1
git add docs/ARCHITECTURE.md
```

Always runs (no path filtering) — matches the "keep it honest, every commit"
decision. The single script call internally covers all three projects (`src`,
`server`, `dashboard`), so the hook itself doesn't need to know about the
multi-root scope. A generator crash (e.g. a TS syntax the parser chokes on)
aborts the commit with the error printed, forcing a fix before the commit
lands, so the doc can never silently drift from the code that's actually
being committed.

Not installed via `.git/hooks` directly in version control (that directory
isn't tracked by git) — the hook file itself gets committed to
`scripts/pre-commit-arch-doc.sh` and a one-line note in `CONTEXT.md` (or
README) tells a fresh clone to symlink/copy it in, OR a `postinstall` script
copies it automatically. Decided: **`postinstall` script** copies
`scripts/pre-commit-arch-doc.sh` to `.git/hooks/pre-commit` (chmod +x) so it's
zero-manual-step for both current and future clones.

## 5. Testing

Vitest test for `gen-arch-doc.ts`'s pure functions (`extractArchitecture`,
`renderMarkdown`), same TDD pattern as the rest of the codebase:

- Fixture: 2-3 small `.ts` files in a test-only temp dir (or in-memory
  `ts-morph` `Project` with `createSourceFile` — no disk fixtures needed) —
  one function with JSDoc, one without, one cross-file import.
- Assert: `extractArchitecture` returns correct domain/module/function
  grouping; `renderMarkdown` output contains expected headers, the
  documented function's description, the `_(undocumented)_` marker for the
  undocumented one, and the import edge under "Interactions".

The hook script itself (shell, glue) stays untested — matches this
codebase's existing carve-out for thin entry-point/wiring code (e.g.
`enrich-products.ts`'s `main()`).

## Global constraints

- `ts-morph` added as a devDependency to the **root** `package.json` only —
  the script runs from root via `tsx`, and `ts-morph` doesn't need to be
  installed inside `server/`/`dashboard/` to read their `tsconfig.json`s and
  source files.
- `scripts/` itself is out of scope for this first version (could extend
  later, separate decision).
- Descriptions are never invented — blank/`_(undocumented)_` is the honest
  state until a human writes the JSDoc.
- No visual graph/SVG output — nested markdown only, per the "one doc"
  decision.
- Doc is committed to the repo (`docs/ARCHITECTURE.md`), not gitignored —
  it's meant to be read via GitHub/editor, not regenerated on demand only.

## Open risks

- `ts-morph`'s `getText()` for signatures can be verbose for complex generic
  types — acceptable for now, revisit only if a specific signature renders
  unreadably.
- Domain grouping by folder convention breaks silently if someone adds a new
  top-level folder under `src/` that doesn't fit the `workers/utils/platform/
  domains/<sub>` pattern — it'll just become its own domain bucket, not an
  error, so no immediate risk.
- Pre-commit hook adds latency to every commit touching `src/` (full project
  parse via ts-morph) — unmeasured; revisit if it becomes annoyingly slow.
