import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.int.test.ts'],
    exclude: ['**/node_modules/**', '.claude/**'],
    globalSetup: ['test/integration/global-setup.ts'],
    // One shared database: files must not race each other's writes.
    fileParallelism: false,
  },
})
