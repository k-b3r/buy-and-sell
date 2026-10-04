import { baseConfig } from '@k-b3r/agent-config/eslint'
import nextPlugin from '@next/eslint-plugin-next'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

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
