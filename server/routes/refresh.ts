import type { Logger } from '../../src/logger'
import type { DbClient } from '../../src/db'
import { getListingCheckCandidate } from '../../src/db'
import type { ImageStore } from '../../src/images'
import type { PageDriver } from '../../src/driver'
import { launchBrowser, createBrowserDriver } from '../../src/browser'
import { checkOneListing } from '../../src/check-listings'
import type { RouteHandler, RouteResult } from '../app'
import type { RefreshPacer } from '../refreshPacer'

export type DriverFactory = () => Promise<{ driver: PageDriver; close: () => Promise<void> }>

const defaultDriverFactory: DriverFactory = async () => {
  const { page, close } = await launchBrowser()
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
