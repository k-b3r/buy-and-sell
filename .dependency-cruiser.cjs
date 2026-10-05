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

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...baseRules({
      publicApis: ['src/domains/llm-clients', ...modules],
      heavyDeps: [
        // Only collection/browser.ts launches a browser; everything else imports it from there.
        { packages: ['playwright', 'playwright-core'], owner: 'src/modules/collection/browser.ts' },
        // sharp and the S3 client are heavy native/SDK deps; platform/images.ts owns them.
        { packages: ['sharp', '@aws-sdk/client-s3'], owner: 'src/platform/images.ts' },
        // One place creates DB pools; everything else takes an injected DbClient.
        { packages: ['pg'], owner: 'src/platform/storage.ts' },
        // LLM SDKs: the llm-clients index and the modules importing it stay SDK-free;
        // workers import the SDK-backed constructors from these files by path.
        { packages: ['groq-sdk'], owner: 'src/domains/llm-clients/groq-sdk.ts' },
        { packages: ['@google/genai'], owner: 'src/domains/llm-clients/gemini-sdk.ts' },
      ],
      inner: ['src/domains', 'src/modules', 'src/platform'],
      entryPoints: ['src/workers', 'src/utils', 'server'],
    }),
  ],
  options: baseOptions({ exclude: ['^dashboard/', '^docs-site/'] }),
}
