import type { Logger } from '../../src/platform/logger'
import type { DbClient } from '../../src/platform/storage'
import { getListingCheckCandidate } from '../../src/domains/marketplace/storage/listings'
import type { ImageStore } from '../../src/platform/images'
import type { PageDriver } from '../../src/domains/marketplace'
import { launchBrowser, createBrowserDriver } from '../../src/domains/marketplace'
import { checkOneListing } from '../../src/workers/check-listings'
import type { RouteHandler, RouteResult } from '../app'
import type { RefreshPacer } from '../refreshPacer'
import { checkTunnelBeforeLaunch, type TunnelCheckResult } from '../tunnelGuard'

export type DriverFactory = () => Promise<{ driver: PageDriver; close: () => Promise<void> }>

// Always routes through SOCKS_PROXY (the laptop-relayed tunnel) - see
// tunnelGuard.ts for why there's no direct-IP fallback.
const defaultDriverFactory: DriverFactory = async () => {
  const { page, close } = await launchBrowser({ socksProxy: process.env.SOCKS_PROXY })
  return { driver: createBrowserDriver(page), close }
}

// Dashboard's "Refresh" button (on-demand, one listing at a time) lands here
// rather than the batch getCheckListingsCandidates backlog - see checkOneListing
// for the shared core logic. Auth/JSON-parsing/routing already happened
// (see ../app.ts) by the time this runs - it only ever sees a parsed body.
export function createRefreshHandler(
  db: DbClient,
  imageStore: ImageStore,
  logger: Logger,
  pacer: RefreshPacer,
  driverFactory: DriverFactory = defaultDriverFactory,
  tunnelCheck: () => Promise<TunnelCheckResult> = checkTunnelBeforeLaunch,
): RouteHandler {
  return async function handleRefresh(body: unknown): Promise<RouteResult> {
    const id = (body as Record<string, unknown> | null)?.id
    if (typeof id !== 'string' || id.trim() === '') {
      return { statusCode: 400, body: { error: 'missing or invalid "id"' } }
    }

    // Cheap DB-only check before ever queueing - a bogus id shouldn't sit
    // through the pacing wait just to 404 at the end of it.
    const candidate = await getListingCheckCandidate(db, id)
    if (!candidate) {
      return { statusCode: 404, body: { error: `listing ${id} not found` } }
    }

    // Fail closed if the tunnel isn't up - checked before ever touching the
    // lock/queue, so a doomed request doesn't sit through the pacing wait
    // first. See tunnelGuard.ts: no action is taken on the listing at all
    // when this fails, by design.
    const tunnel = await tunnelCheck()
    if (!tunnel.ok) {
      logger.error(`refusing to refresh listing ${id}: ${tunnel.error}`)
      return { statusCode: 503, body: { error: tunnel.error } }
    }

    // Queues behind whatever else is using the shared browser (single-listing
    // or bulk product-refresh - the VPS has ~2GB RAM, not enough for two
    // concurrent Chromium instances), then paces itself against whenever
    // Facebook was last actually touched - see refreshPacer.ts. false means
    // it sat past the max wait still busy (e.g. a long bulk job), not worth
    // holding the HTTP request open any further.
    const gotTurn = await pacer.waitForTurn()
    if (!gotTurn) {
      return { statusCode: 429, body: { error: 'a refresh is already in progress, try again shortly' } }
    }

    try {
      const { driver, close } = await driverFactory()
      try {
        logger.info(`on-demand refresh: listing ${id}`)
        await driver.openListing({ id })
        const result = await checkOneListing(driver, db, imageStore, logger, candidate)
        return { statusCode: 200, body: { status: result.status } }
      } finally {
        await close()
      }
    } finally {
      pacer.recordActionComplete()
      pacer.release()
    }
  }
}
