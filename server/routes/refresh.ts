import type { Logger } from '../../src/logger'
import type { DbClient } from '../../src/db'
import { getListingCheckCandidate } from '../../src/db'
import type { ImageStore } from '../../src/images'
import type { PageDriver } from '../../src/driver'
import { launchBrowser, createBrowserDriver } from '../../src/browser'
import { checkOneListing } from '../../src/check-listings'
import type { RouteHandler, RouteResult } from '../app'
import type { RefreshLock } from '../refreshLock'

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
  lock: RefreshLock,
  driverFactory: DriverFactory = defaultDriverFactory,
): RouteHandler {
  return async function handleRefresh(body: unknown): Promise<RouteResult> {
    const id = (body as Record<string, unknown> | null)?.id
    if (typeof id !== 'string' || id.trim() === '') {
      return { statusCode: 400, body: { error: 'missing or invalid "id"' } }
    }
    // Shared with the bulk product-refresh handler (see routes/refreshProduct.ts)
    // - the VPS this runs on has ~2GB RAM, not enough for two concurrent
    // Chromium instances, so a single-listing refresh and a bulk job must
    // never run simultaneously either.
    if (lock.isBusy()) {
      return { statusCode: 429, body: { error: 'a refresh is already in progress, try again shortly' } }
    }

    lock.acquire()
    try {
      const candidate = await getListingCheckCandidate(db, id)
      if (!candidate) {
        return { statusCode: 404, body: { error: `listing ${id} not found` } }
      }

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
      lock.release()
    }
  }
}
