import type { ListingPhotos } from '../src/modules/collection'
import { launchBrowserDriver } from '../src/modules/collection/browser'
import { realDelay } from '../src/platform/delay'
import type { Logger } from '../src/platform/logger'
import type { QueryClient } from '../src/platform/storage'
import type { RouteHandler } from './app'
import { createJobStore } from './jobState'
import { createProxyGuard, type ProxyGuardEnv } from './proxyGuard'
import { createRefreshLock } from './refreshLock'
import { createRefreshPacer } from './refreshPacer'
import { createRefreshHandler } from './routes/refresh'
import { createCancelRefreshJobHandler } from './routes/refreshJobCancel'
import { createRefreshJobStatusHandler } from './routes/refreshJob'
import { createRefreshProductHandler } from './routes/refreshProduct'

export interface RefreshHandlersDeps {
  db: QueryClient
  photos: ListingPhotos
  logger: Logger
  // Read once in server/index.ts and injected, like the proxy guard's env.
  env: ProxyGuardEnv
}

export interface RefreshHandlers {
  refresh: RouteHandler
  refreshProduct: RouteHandler
  jobStatus: RouteHandler
  cancelJob: RouteHandler
}

// Builds every handler that drives a browser refresh, with the shared lock,
// pacer and job store behind them. server/index.ts maps each one to its route.
export function createRefreshHandlers({ db, photos, logger, env }: RefreshHandlersDeps): RefreshHandlers {
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
  }

  return {
    refresh: createRefreshHandler(refreshDeps),
    refreshProduct: createRefreshProductHandler({ ...refreshDeps, lock: refreshLock, jobs }),
    jobStatus: createRefreshJobStatusHandler(jobs),
    cancelJob: createCancelRefreshJobHandler(jobs),
  }
}
