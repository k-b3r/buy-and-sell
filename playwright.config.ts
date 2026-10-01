import { defineConfig, devices } from '@playwright/test'
import { E2E_API_KEY, E2E_DASHBOARD_PORT, E2E_PASSWORD, E2E_SERVER_PORT } from './e2e/env'
import { testDatabaseUrl } from './test/integration/global-setup'

const databaseUrl = testDatabaseUrl()

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './test/integration/global-setup.ts',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${E2E_DASHBOARD_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm exec tsx index.ts',
      cwd: 'server',
      port: E2E_SERVER_PORT,
      reuseExistingServer: false,
      env: {
        DATABASE_URL: databaseUrl,
        REFRESH_API_KEY: E2E_API_KEY,
        SERVER_PORT: String(E2E_SERVER_PORT),
        // Only checked for presence at boot; e2e never touches stored photos.
        R2_ACCOUNT_ID: 'e2e',
        R2_ACCESS_KEY_ID: 'e2e',
        R2_SECRET_KEY: 'e2e',
        R2_BUCKET_NAME: 'e2e',
        R2_PUBLIC_BASE_URL: 'http://localhost/e2e',
      },
    },
    {
      command: `pnpm build && pnpm start -p ${E2E_DASHBOARD_PORT}`,
      cwd: 'dashboard',
      url: `http://localhost:${E2E_DASHBOARD_PORT}/login`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        DASHBOARD_PASSWORD: E2E_PASSWORD,
        REFRESH_SERVER_URL: `http://localhost:${E2E_SERVER_PORT}`,
        REFRESH_API_KEY: E2E_API_KEY,
      },
    },
  ],
})
