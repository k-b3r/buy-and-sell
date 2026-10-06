import { baseConfig } from '@k-b3r/agent-config/eslint'
import nextPlugin from '@next/eslint-plugin-next'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

// Entry points wire dependencies and loop; decisions live in modules
// (CODING_STANDARDS.md > Structure). The shared config only warns on size and
// complexity; here they block, so logic can't creep back into an entry point.
const ENTRY_POINT_FILES = ['src/workers/*/index.ts', 'src/utils/*/index.ts', 'server/routes/*.ts']
const ENTRY_POINT_MAX_LINES = 200
const ENTRY_POINT_MAX_COMPLEXITY = 13

// Hand-curated lookup tables, some with the small function that applies
// them (one concern each). Length grows with the curated data, not with
// logic, so max-lines says nothing useful here; complexity still applies.
const CURATED_DATA_FILES = [
  'src/modules/catalog/variant-alias-rules.ts',
  'src/modules/pricing/ineligible-categories.ts',
  'src/modules/pricing/generic-products.ts',
]

export default [
  ...baseConfig({
    tsconfigRootDir: import.meta.dirname,
    allowDefaultProject: [
      'docs-site/.vitepress/config.ts',
      'scripts/*.ts',
      'vitest.config.ts',
      'vitest.integration.config.ts',
      'dashboard/vitest.config.mts',
    ],
    entryPoints: [
      'src/workers/*/index.ts',
      'src/utils/*/index.ts',
      'server/index.ts',
      'scripts/*.ts',
      // Framework app: follows Next.js conventions (server components read env).
      'dashboard/**',
    ],
    delayModules: ['src/platform/delay.ts'],
    // Next.js pages, layouts and components default-export by convention; vitepress
    // and Playwright's globalSetup require a default export.
    defaultExportAllowed: ['dashboard/**', 'docs-site/.vitepress/config.ts', 'tests/integration/global-setup.ts'],
    ignores: [
      'dashboard/.next/**',
      'dashboard/next-env.d.ts',
      'docs-site/.vitepress/dist/**',
      'docs-site/.vitepress/cache/**',
      'dashboard/public/**',
      '.claude/**',
      'data/**',
      'fixtures/**',
    ],
  }),
  {
    files: ENTRY_POINT_FILES,
    ignores: ['**/*.test.ts'],
    rules: {
      'max-lines': ['error', { max: ENTRY_POINT_MAX_LINES, skipBlankLines: true, skipComments: true }],
      complexity: ['error', ENTRY_POINT_MAX_COMPLEXITY],
    },
  },
  {
    files: CURATED_DATA_FILES,
    rules: { 'max-lines': 'off' },
  },
  {
    files: ['dashboard/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    settings: { next: { rootDir: 'dashboard' } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]
