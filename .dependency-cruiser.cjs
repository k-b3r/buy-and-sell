// Module boundary rules (CODING_STANDARDS.md: deep modules, side-effect-free
// imports, heavy deps behind their own entry point). Run: pnpm depcruise.
// Shared rules come from @k-b3r/agent-config; repo-specific ones follow.
const { baseRules, baseOptions } = require('@k-b3r/agent-config/dependency-cruiser')

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...baseRules({
      publicApis: ['src/domains/marketplace', 'src/domains/llm-clients', 'src/modules/pricing', 'src/modules/real-estate'],
      heavyDeps: [
        // Only marketplace/browser.ts launches a browser; everything else imports it from there.
        { packages: ['playwright', 'playwright-core'], owner: 'src/domains/marketplace/browser.ts' },
        // sharp and the S3 client are heavy native/SDK deps; platform/images.ts owns them.
        { packages: ['sharp', '@aws-sdk/client-s3'], owner: 'src/platform/images.ts' },
        // One place creates DB pools; everything else takes an injected DbClient.
        { packages: ['pg'], owner: 'src/platform/storage.ts' },
      ],
      inner: ['src/domains', 'src/modules'],
      entryPoints: ['src/workers', 'src/utils', 'server'],
    }),
  ],
  options: baseOptions({ exclude: ['^dashboard/', '^docs-site/'] }),
}
