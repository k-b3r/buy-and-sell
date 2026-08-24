import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../src/logger'
import { createDbPool } from '../src/db'
import { createR2ImageStore } from '../src/images'
import { createApp } from './app'
import { createRefreshHandler } from './routes/refresh'
import { createRefreshProductHandler } from './routes/refreshProduct'
import { createRefreshJobStatusHandler } from './routes/refreshJob'
import { createCancelRefreshJobHandler } from './routes/refreshJobCancel'
import { createRefreshLock } from './refreshLock'
import { createRefreshPacer } from './refreshPacer'
import { createJobStore } from './jobState'

// Run from within server/ (`pnpm start` / `pnpm dev`) - .env is resolved
// relative to CWD, so this expects server/.env, a separate file from the
// root scripts' .env (mirrors dashboard/.env.local being its own file too).
async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const apiKey = process.env.REFRESH_API_KEY
  if (!apiKey) throw new Error('REFRESH_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — the server requires Postgres')

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL } = process.env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_BASE_URL) {
    throw new Error('R2 not fully configured in .env — the refresh route needs to be able to delete photos')
  }

  const port = Number(process.env.SERVER_PORT ?? 8787)

  const logger = createLogger('server.log')
  const pool = createDbPool(dbUrl)
  const imageStore = createR2ImageStore({
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_KEY,
    bucket: R2_BUCKET_NAME,
    publicBaseUrl: R2_PUBLIC_BASE_URL,
  })

  // Shared across the single-listing and bulk product-refresh handlers -
  // this VPS can't run two concurrent Chromium instances (~2GB RAM), so
  // either use case must lock the other out. jobs is likewise one shared
  // in-memory slot (see jobState.ts) - only one job can ever be running at
  // a time anyway, since they share this same lock. refreshPacer wraps the
  // lock with queueing + human pacing for single-listing requests (see
  // refreshPacer.ts) - bulk keeps using the raw lock directly (it already
  // paces itself internally) but still reports into the same pacer so a
  // single-listing request right after a bulk job doesn't skip the gap.
  const refreshLock = createRefreshLock()
  const refreshPacer = createRefreshPacer(refreshLock)
  const jobs = createJobStore()

  // Add a new use case by adding an entry here (e.g. "POST /some-route":
  // createSomeHandler(...)) - createApp handles auth/JSON parsing/routing
  // for every entry uniformly, so a new route only ever needs its own logic.
  const app = createApp(apiKey, {
    'POST /refresh': createRefreshHandler(pool, imageStore, logger, refreshPacer),
    'POST /refresh-product': createRefreshProductHandler(pool, imageStore, logger, refreshLock, jobs, refreshPacer),
    'GET /refresh-job': createRefreshJobStatusHandler(jobs),
    'POST /refresh-job/cancel': createCancelRefreshJobHandler(jobs),
  })

  app.listen(port, () => {
    logger.info(`server listening on port ${port}`)
  })
}

// Guard so importing this module (e.g. from tests) doesn't also start the
// server — see other scripts' main() guard for the same precedent.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
