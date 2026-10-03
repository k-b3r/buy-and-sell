import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '.claude/worktrees/**', '**/*.int.test.ts', 'tests/e2e/**'],
  },
})
