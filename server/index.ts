import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../src/platform/logger'
import { secretsFromEnv } from '../src/platform/redact'
import { createDbPool } from '../src/platform/storage'
import { createCatalogRouter } from '../src/modules/catalog/routes'
import { createListingPhotos, getListingProductId } from '../src/modules/collection'
import { createCollectionRouter } from '../src/modules/collection/routes'
import { createPricingRouter } from '../src/modules/pricing/routes'
import { createRealEstateRouter } from '../src/modules/real-estate/routes'
import { createApp } from './app'
import { createCache } from './cache'
import { loadServerConfig } from './config'
import { createLogsHandler } from './routes/logs'
import { createWorkerControlHandler } from './routes/workerControl'
import { invalidateAfterJobStatus, invalidateAfterListingRefresh } from './queryInvalidation'
import { createQueryHandler } from './routes/query'
import { createSettingsRouter } from './routes/settings'
import { createRefreshHandlers } from './refreshHandlers'

// Run from within server/ (`pnpm start` / `pnpm dev`) - .env is resolved
// relative to CWD, so this expects server/.env, a separate file from the
// root scripts' .env (mirrors dashboard/.env.local being its own file too).
async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }

  const { apiKey, dbUrl, photoIo, port } = loadServerConfig(process.env)

  const logger = createLogger('server.log', secretsFromEnv(process.env))
  const pool = createDbPool(dbUrl)
  const photos = createListingPhotos({ ...photoIo, logger })
  const cache = createCache()

  // Add a new use case by adding an entry here (e.g. "POST /some-route":
  // createSomeHandler(...)) - createApp handles auth/JSON parsing/routing
  // for every entry uniformly, so a new route only ever needs its own logic.
  const refreshHandlers = createRefreshHandlers({ db: pool, photos, logger, env: process.env })
  const app = createApp({
    apiKey,
    log: (msg) => logger.error(msg),
    routers: [
      createSettingsRouter(pool),
      createCollectionRouter(pool, cache),
      createCatalogRouter(pool, cache),
      createPricingRouter(pool, cache),
      createRealEstateRouter(pool),
    ],
    routes: {
      'POST /refresh': invalidateAfterListingRefresh(refreshHandlers.refresh, cache, (id) =>
        getListingProductId(pool, id),
      ),
      'POST /refresh-product': refreshHandlers.refreshProduct,
      'GET /refresh-job': invalidateAfterJobStatus(refreshHandlers.jobStatus, cache),
      'POST /refresh-job/cancel': refreshHandlers.cancelJob,
      'POST /logs': createLogsHandler(),
      'POST /worker-control': createWorkerControlHandler(),
      'POST /query': createQueryHandler(pool, (msg) => logger.error(msg)),
    },
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
