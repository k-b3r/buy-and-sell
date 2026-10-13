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
    // Only collection/browser.ts launches a browser; everything else imports it from there.
    { packages: ['playwright', 'playwright-core'], owner: 'src/modules/collection/browser.ts' },
    // sharp and the S3 client are heavy native/SDK deps; platform/images.ts owns them.
    { packages: ['sharp', '@aws-sdk/client-s3'], owner: 'src/platform/images.ts' },
    // One place creates DB pools; everything else takes an injected DbClient.
    { packages: ['pg'], owner: 'src/platform/storage.ts' },
    // LLM SDKs: the llm-clients index and the modules importing it stay SDK-free;
    // workers import the SDK-backed constructors from these files by path.
    { packages: ['groq-sdk'], owner: 'src/platform/llm-clients/groq-sdk.ts' },
    { packages: ['@google/genai'], owner: 'src/platform/llm-clients/gemini-sdk.ts' },
  ],
  inner: ['src/modules', 'src/platform'],
  entryPoints: ['src/workers', 'src/utils', 'server'],
})

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // server/ reaches past a module's index.ts for routes.ts only.
    ...sharedRules.map((rule) =>
      rule.name.startsWith('no-deep-imports-into-src-modules-')
        ? { ...rule, to: { ...rule.to, pathNot: [...rule.to.pathNot, MODULE_ROUTES] } }
        : rule,
    ),
    {
      name: 'module-routes-only-from-server',
      severity: 'error',
      comment: "routes.ts pulls in express: only server/ (and the module's own test) may import it.",
      from: { pathNot: ['^server/', '^src/modules/[^/]+/routes\\.(test\\.)?ts$'] },
      to: { path: MODULE_ROUTES },
    },
  ],
  options: baseOptions({ exclude: ['^dashboard/', '^docs-site/'] }),
}
