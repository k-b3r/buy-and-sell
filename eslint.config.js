import js from '@eslint/js'
import nextPlugin from '@next/eslint-plugin-next'
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'dashboard/.next/**',
      'dashboard/next-env.d.ts',
      'docs-site/.vitepress/dist/**',
      'docs-site/.vitepress/cache/**',
      'dashboard/public/**',
      '.claude/**',
      'data/**',
      'fixtures/**',
      // Deliberately violating files; linted only by tests/lint-config.test.ts.
      'tests/lint-fixtures/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  eslintComments.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'docs-site/.vitepress/config.ts',
            'scripts/*.ts',
            'vitest.config.ts',
            'vitest.integration.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unawaited promises in long-running workers silently drop errors.
      '@typescript-eslint/no-floating-promises': 'error',
      // JSX handlers like onClick={async () => ...} are fine; React ignores the returned promise.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'separate-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description' }],
      // Every disable names its rule and says why (`-- reason`).
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      // A folder's index.ts is its public API: name each export.
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportAllDeclaration', message: 'List exports explicitly; never export *.' },
      ],
    },
  },
  {
    // Domain code gets config injected; reading env here hides a dependency.
    files: ['**/src/domains/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Take env values as a parameter; read process.env in the worker entry point.',
        },
      ],
    },
  },
  {
    // Sleeps go through the injectable DelayFn so tests can pass a no-op.
    files: ['**/src/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/platform/utils.ts'],
    rules: {
      // Restates the export ban: a later block's no-restricted-syntax replaces earlier options.
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportAllDeclaration', message: 'List exports explicitly; never export *.' },
        {
          selector:
            "NewExpression[callee.name='Promise'] > ArrowFunctionExpression > CallExpression[callee.name='setTimeout']",
          message: 'Inject a DelayFn (src/platform/utils.ts realDelay) instead of sleeping inline.',
        },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
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
  prettier,
)
