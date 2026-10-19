// Module boundary rules (CODING_STANDARDS.md: deep modules, side-effect-free
// imports, heavy deps behind their own entry point). Run: pnpm depcruise.
// Shared rules come from @k-b3r/agent-config; repo-specific ones follow.
const { readdirSync } = require('node:fs')
const path = require('node:path')
const { baseRules, baseOptions } = require('@k-b3r/agent-config/dependency-cruiser')

// Every feature module is a public API, read from disk so a new module can't
// be left out of the boundary rules.
const modules = readdirSync(path.join(__dirname, 'src/modules'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `src/modules/${entry.name}`)

// A module's routes.ts is the HTTP edge of that feature. It imports express, so
// only server/ may load it: the module's index.ts never exports it, and workers
// importing the module never pull express in.
const MODULE_ROUTES = '^src/modules/[^/]+/routes\\.ts$'

const sharedRules = baseRules({
  publicApis: ['src/platform/llm-clients', ...modules],
  heavyDeps: [
    // Only collection/clients/browser.ts launches a browser; everything else imports it from there.
    { packages: ['playwright', 'playwright-core'], owner: 'src/modules/collection/clients/browser.ts' },
    // sharp and the S3 client are heavy native/SDK deps; platform/images.ts owns them.
    { packages: ['sharp', '@aws-sdk/client-s3'], owner: 'src/platform/images.ts' },
    // One place creates DB pools; everything else takes an injected DbClient.
    { packages: ['pg'], owner: 'src/platform/storage.ts' },
    // LLM SDKs: the llm-clients index and the modules importing it stay SDK-free;
    // workers import the SDK-backed constructors from these files by path.
    { packages: ['groq-sdk'], owner: 'src/platform/llm-clients/groq-sdk.ts' },
    { packages: ['@google/genai'], owner: 'src/platform/llm-clients/gemini-sdk.ts' },
  ],
  // Tier order, lowest first (CODING_STANDARDS.md): a module imports only lower tiers.
  moduleTiers: { dir: 'src/modules', tiers: [['real-estate'], ['pricing'], ['catalog'], ['collection']] },
  inner: ['src/modules', 'src/platform'],
  entryPoints: ['src/workers', 'src/utils', 'server'],
})

// baseOptions() cruises the runtime graph, where `import type` is erased and no
// rule can see it. domain/ must not even name a store row or a DbClient, so this
// repo cruises the compilation graph instead and the shared rules, which guard
// what actually loads, opt back out of type-only edges.
const runtimeOnly = (rule) => ({ ...rule, to: { ...rule.to, dependencyTypesNot: ['type-only'] } })

// Reachability rules accept only path/pathNot (dependency-cruiser rejects
// dependencyTypesNot on them), so their type-only edges cannot be filtered:
// every module index that re-exports a port type (DbClient, ImageStore) now
// reaches platform/storage.ts or platform/images.ts through store/ and types.ts.
// Those two owners get a direct-import rule below; the reachable rule keeps the
// owners that no index type-imports.
const TYPE_IMPORTED_HEAVY_OWNERS = ['src/platform/images', 'src/platform/storage']
const indexStaysLight = sharedRules.find((rule) => rule.name === 'index-stays-light')
const isTypeImportedOwner = (ownerPath) => TYPE_IMPORTED_HEAVY_OWNERS.some((owner) => ownerPath.includes(owner))

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // server/ reaches past a module's index.ts for routes.ts only.
    ...sharedRules
      .filter((rule) => rule.name !== 'index-stays-light')
      .map(runtimeOnly)
      .map((rule) =>
        rule.name.startsWith('no-deep-imports-into-src-modules-')
          ? { ...rule, to: { ...rule.to, pathNot: [...rule.to.pathNot, MODULE_ROUTES] } }
          : rule,
      ),
    ...(indexStaysLight
      ? [
          {
            ...indexStaysLight,
            to: {
              ...indexStaysLight.to,
              path: indexStaysLight.to.path.filter((ownerPath) => !isTypeImportedOwner(ownerPath)),
            },
          },
          {
            name: 'index-does-not-import-heavy-deps',
            severity: 'error',
            comment:
              'An index.ts is the light entry to its folder: import heavy deps (Playwright, sharp/S3, pg, LLM SDKs) only from their owner file, and never from the index. Type-only imports load nothing and stay allowed.',
            from: indexStaysLight.from,
            to: { path: indexStaysLight.to.path, dependencyTypesNot: ['type-only'] },
          },
        ]
      : []),
    // domain/ is pure code: no store, clients or app, not even for a type, and no
    // storage or logger. Those enter through the module's ports (types.ts).
    {
      name: 'domain-no-effects',
      severity: 'error',
      comment:
        "domain/ is pure: it never imports store/, clients/ or app/ (its own module's or another's), nor platform/storage or platform/logger, not even as a type. Take them in as arguments through types.ts ports.",
      from: { path: '^src/modules/[^/]+/domain/' },
      to: {
        path: ['^src/modules/[^/]+/(store|clients|app)/', '^src/platform/(storage|logger)(\\.ts|/)'],
      },
    },
    {
      name: 'module-routes-only-from-server',
      severity: 'error',
      comment: "routes.ts pulls in express: only server/ (and the module's own test) may import it.",
      from: { pathNot: ['^server/', '^src/modules/[^/]+/routes\\.(test\\.)?ts$'] },
      to: { path: MODULE_ROUTES },
    },
  ],
  // `specify` keeps type-only edges in the graph and marks them, so domain-no-effects
  // sees `import type`; the runtimeOnly wrapper above keeps the shared rules honest.
  options: { ...baseOptions({ exclude: ['^dashboard/', '^docs-site/'] }), tsPreCompilationDeps: 'specify' },
}
