import express from 'express'
import type { Router } from 'express'
import type { ListingPhotos } from '../src/modules/collection'
import { launchBrowserDriver } from '../src/modules/collection/clients/browser'
import { realDelay } from '../src/platform/delay'
import type { Logger } from '../src/platform/logger'
import type { QueryClient } from '../src/platform/storage'
import type { CacheInvalidator } from '../src/platform/cache'
import { createJobStore } from './jobState'
import { createProxyGuard, type ProxyGuardEnv } from './proxyGuard'
import { createRefreshLock } from './refreshLock'
import { createRefreshPacer } from './refreshPacer'
import { createRefreshHandler } from './routes/refresh'
import { createCancelRefreshJobHandler } from './routes/refreshJobCancel'
import { createRefreshJobStatusHandler } from './routes/refreshJob'
import { createRefreshProductHandler } from './routes/refreshProduct'
import type { RouteHandler } from './routes/result'
import { sendResult } from './routes/result'

export interface RefreshHandlersDeps {
  db: QueryClient
  photos: ListingPhotos
  logger: Logger
  // Read once in server/index.ts and injected, like the proxy guard's env.
  env: ProxyGuardEnv
  // The handlers drop the listing and product reads their writes make stale.
  cache: CacheInvalidator
}

export interface RefreshHandlers {
  refresh: RouteHandler
  refreshProduct: RouteHandler
  jobStatus: RouteHandler
  cancelJob: RouteHandler
}

// Builds every handler that drives a browser refresh, with the shared lock,
// pacer and job store behind them. createRefreshRouter mounts them.
export function createRefreshHandlers({ db, photos, logger, env, cache }: RefreshHandlersDeps): RefreshHandlers {
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
  // Every browser launch goes through a residential proxy (see proxyGuard.ts):
  // both refresh handlers pass the guard's resolved proxy to launchBrowserDriver,
  // with no direct-IP fallback.
  const proxyGuard = createProxyGuard(env)
  const refreshDeps = {
    db,
    photos,
    logger,
    delay: realDelay,
    pacer: refreshPacer,
    driverFactory: launchBrowserDriver,
    tunnelCheck: proxyGuard,
    cache,
  }

  return {
    refresh: createRefreshHandler(refreshDeps),
    refreshProduct: createRefreshProductHandler({ ...refreshDeps, lock: refreshLock, jobs }),
    jobStatus: createRefreshJobStatusHandler(jobs),
    cancelJob: createCancelRefreshJobHandler(jobs),
  }
}

// Every refresh route, mounted by server/index.ts. The body-driven forms are
// POST /refresh with { id } and POST /refresh-product with { productId }; the
// id-in-path forms exist too, so the browser's /api/listings/:id/refresh and
// /api/products/:id/refresh rewrite straight to the server with no body to
// build. The job routes report and cancel the bulk job those two start.
export function createRefreshRouter(handlers: RefreshHandlers): Router {
  const router = express.Router()

  router.post('/refresh', async (req, res) => {
    sendResult(res, await handlers.refresh(req.body ?? {}))
  })

  router.post('/refresh-product', async (req, res) => {
    sendResult(res, await handlers.refreshProduct(req.body ?? {}))
  })

  router.post('/listings/:id/refresh', async (req, res) => {
    sendResult(res, await handlers.refresh({ id: req.params.id }))
  })

  // A non-numeric id becomes NaN, which the handler answers with its usual 400.
  router.post('/products/:id/refresh', async (req, res) => {
    sendResult(res, await handlers.refreshProduct({ productId: Number(req.params.id) }))
  })

  router.get('/refresh-job', async (_req, res) => {
    sendResult(res, await handlers.jobStatus({}))
  })

  router.post('/refresh-job/cancel', async (_req, res) => {
    sendResult(res, await handlers.cancelJob({}))
  })

  return router
}
