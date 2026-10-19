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
  'src/modules/catalog/domain/variant-alias-rules.ts',
  'src/modules/pricing/ineligible-categories.ts',
  'src/modules/pricing/generic-products.ts',
]

// A later no-restricted-syntax block replaces the shared list, so the store
// block restates it (the shared config does not export it) next to the new
// selector; tests/lint-config.test.ts fails if the two drift apart.
const STORE_ONLY_SQL = {
  selector: "CallExpression[callee.property.name='query']",
  message:
    'SQL lives in the module store/ folder (docs/specs/2026-10-14-module-layout.md): move this .query() call there.',
}
const NO_RUN_EXPORT = {
  selector: [
    'ExportNamedDeclaration > FunctionDeclaration[id.name=/^run[A-Z]/]',
    'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name=/^run[A-Z]/]',
    'ExportSpecifier[exported.name=/^run[A-Z]/]',
  ].join(', '),
  message:
    'Run loops live in the worker/util that calls them, as a sibling run.ts (docs/specs/2026-10-14-module-layout.md); modules export capabilities.',
}
const SHARED_RESTRICTED_SYNTAX = [
  { selector: 'ExportAllDeclaration', message: 'List exports explicitly; never export *.' },
  { selector: 'ExportDefaultDeclaration', message: 'Use named exports.' },
  {
    selector:
      "NewExpression[callee.name='Promise'] > ArrowFunctionExpression > CallExpression[callee.name='setTimeout']",
    message: 'Inject a delay function so tests can pass a no-op; only the delay module sleeps.',
  },
]

// Pure code (CODING_STANDARDS.md > Architecture). The shared config bans clock and
// randomness there with no-restricted-syntax selectors, but a later block replaces
// that list, so the module blocks below restate it (read back from the shared
// config) for domain/ files.
const PURE_CORE_PATHS = ['src/modules/*/domain/**']

const sharedConfig = baseConfig({
  tsconfigRootDir: import.meta.dirname,
  pureCorePaths: PURE_CORE_PATHS,
  // SQL takes values as $n parameters; only constant fragments (SCREAMING_CASE, or names ending Sql/Clause/Placeholder) may be interpolated.
  parameterizedSqlFiles: ['src/modules/**/*.ts', 'server/**/*.ts'],
  sqlFragment: '^[A-Z][A-Z0-9_]*$|(Sql|SQL|Ctes|Lateral|Clause|Placeholder)\\b|^params\\.length( - [12])?$',
  // Domain code logs through the injected Logger, which redacts secrets.
  noConsoleFiles: ['src/modules/**/*.ts', 'src/platform/**/*.ts'],
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
})

// Relies on the shared config passing the same array reference through; the domain/ test in tests/lint-config.test.ts fails if that breaks.
const pureCoreBlock = sharedConfig.find((block) => block.files === PURE_CORE_PATHS)
const PURE_CORE_SYNTAX = pureCoreBlock?.rules?.['no-restricted-syntax']?.slice(1) ?? []

export default [
  ...sharedConfig,
  {
    files: ENTRY_POINT_FILES,
    ignores: ['**/*.test.ts'],
    rules: {
      'max-lines': ['error', { max: ENTRY_POINT_MAX_LINES, skipBlankLines: true, skipComments: true }],
      complexity: ['error', ENTRY_POINT_MAX_COMPLEXITY],
    },
  },
  {
    files: ['src/modules/**/*.ts'],
    ignores: ['**/store/**', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...SHARED_RESTRICTED_SYNTAX, STORE_ONLY_SQL, NO_RUN_EXPORT],
    },
  },
  {
    files: PURE_CORE_PATHS,
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...PURE_CORE_SYNTAX, STORE_ONLY_SQL, NO_RUN_EXPORT] },
  },
  // The logger is the console sink everything else goes through; its `line` is already redacted.
  { files: ['src/platform/logger.ts'], rules: { 'no-console': 'off' } },
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
