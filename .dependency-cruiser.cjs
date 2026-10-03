// Module boundary rules (CODING_STANDARDS.md: deep modules, side-effect-free
// imports, heavy deps behind their own entry point). Run: pnpm depcruise.
const npm = (pkg) => `node_modules/.*${pkg}/`
const testFiles = ['\\.test\\.ts$', '^tests/', '^playwright\\.config\\.ts$']

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Runtime import cycles make load order ambiguous. Type-only edges are erased at compile time, so they may close a loop.',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'playwright-only-in-browser',
      severity: 'error',
      comment: 'Only marketplace/browser.ts launches a browser; everything else imports it from there.',
      from: { path: '^(src|server)/', pathNot: ['^src/domains/marketplace/browser\\.ts$', ...testFiles] },
      to: { path: [npm('playwright'), npm('playwright-core')] },
    },
    {
      name: 'image-and-s3-only-in-images',
      severity: 'error',
      comment: 'sharp and the S3 client are heavy native/SDK deps; platform/images.ts owns them.',
      from: { path: '^(src|server)/', pathNot: ['^src/platform/images\\.ts$', ...testFiles] },
      to: { path: [npm('sharp'), npm('@aws-sdk/client-s3')] },
    },
    {
      name: 'pg-only-in-storage',
      severity: 'error',
      comment: 'One place creates DB pools; everything else takes an injected DbClient.',
      from: { path: '^(src|server)/', pathNot: ['^src/platform/storage\\.ts$', ...testFiles] },
      to: { path: npm('pg') },
    },
    {
      name: 'marketplace-barrel-stays-light',
      severity: 'error',
      comment: 'Importing the marketplace public API must never load Playwright.',
      from: { path: '^src/domains/marketplace/index\\.ts$' },
      to: { path: '^src/domains/marketplace/browser\\.ts$', reachable: true },
    },
    ...['marketplace', 'llm-clients'].map((domain) => ({
      name: `no-deep-imports-into-${domain}`,
      severity: 'error',
      comment:
        "Callers outside a domain folder use its index.ts (plus marketplace/browser.ts, Playwright's own entry).",
      from: { path: '^(src|server)/', pathNot: `^src/domains/${domain}/` },
      to: {
        path: `^src/domains/${domain}/`,
        pathNot: [`^src/domains/${domain}/index\\.ts$`, '^src/domains/marketplace/browser\\.ts$'],
      },
    })),
    {
      name: 'domains-do-not-import-entry-points',
      severity: 'error',
      comment: 'Domains decide; workers, utils, and the server wire and loop. Dependencies point inward only.',
      from: { path: '^src/domains/' },
      to: { path: ['^src/workers/', '^src/utils/', '^server/'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['^dashboard/', '^docs-site/', '^tests/lint-fixtures/'] },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
}
