import type { Logger } from '../../src/logger'
import type { DbClient } from '../../src/db'
import { getListingCheckCandidatesForProduct } from '../../src/db'
import type { ImageStore } from '../../src/images'
import { checkOneListing } from '../../src/check-listings'
import type { RouteHandler, RouteResult } from '../app'
import type { RefreshLock } from '../refreshLock'
import type { JobStore } from '../jobState'
import type { DriverFactory } from './refresh'
import { launchBrowser, createBrowserDriver } from '../../src/browser'

const defaultDriverFactory: DriverFactory = async () => {
  const { page, close } = await launchBrowser()
  return { driver: createBrowserDriver(page), close }
}

// Same human-paced gap as the CLI's batch loop (src/check-listings.ts's
// runCheckListings) - this hits live Facebook, so a dashboard-triggered bulk
// job gets no less pacing than the scheduled one does.
const MIN_PAUSE_MS = 4000
const MAX_PAUSE_MS = 10000

// Dashboard's "Refresh all listings" button on a product page. Shares
// RefreshLock with the single-listing handler (routes/refresh.ts) - one
// browser at a time, server-wide, either use case. Unlike that handler, this
// one returns as soon as the job STARTS, not when it finishes - a product's
// worth of listings can take many minutes (real browser navigation per
// listing), too long to hold one HTTP request open. The loop itself runs
// detached, updating the shared JobStore as it goes; the dashboard polls
// GET /refresh-job (routes/refreshJob.ts) separately for progress.
export function createRefreshProductHandler(
  db: DbClient,
  imageStore: ImageStore,
  logger: Logger,
  lock: RefreshLock,
  jobs: JobStore,
  driverFactory: DriverFactory = defaultDriverFactory,
): RouteHandler {
  return async function handleRefreshProduct(body: unknown): Promise<RouteResult> {
    const productId = (body as Record<string, unknown> | null)?.productId
    if (typeof productId !== 'number' || !Number.isInteger(productId)) {
      return { statusCode: 400, body: { error: 'missing or invalid "productId"' } }
    }
    if (lock.isBusy()) {
      return { statusCode: 429, body: { error: 'a refresh is already in progress, try again shortly' } }
    }

    const candidates = await getListingCheckCandidatesForProduct(db, productId)
    if (candidates.length === 0) {
      jobs.start(productId, 0)
      jobs.finish('completed')
      return { statusCode: 200, body: { productId, total: 0 } }
    }

    lock.acquire()
    jobs.start(productId, candidates.length)

    // Detached on purpose - see the function doc comment above. Errors are
    // logged, not thrown, since nothing is awaiting this promise.
    void (async () => {
      const { driver, close } = await driverFactory()
      try {
        for (const candidate of candidates) {
          if (jobs.isCancelRequested()) {
            logger.info(`bulk refresh for product ${productId} cancelled`)
            jobs.finish('cancelled')
            return
          }
          await driver.waitRandom(MIN_PAUSE_MS, MAX_PAUSE_MS)
          logger.info(`bulk refresh: product ${productId}, listing ${candidate.id}`)
          await driver.openListing({ id: candidate.id })
          const result = await checkOneListing(driver, db, imageStore, logger, candidate)
          jobs.recordCompletion()
          if (result.status === 'hard-block') {
            logger.error(`bulk refresh for product ${productId} stopped early on hard-block`)
            break
          }
        }
        jobs.finish('completed')
      } catch (err) {
        logger.error(`bulk refresh for product ${productId} failed: ${err}`)
        jobs.finish('completed')
      } finally {
        // Release before closing, not after - a new request needs the lock
        // free to launch its own separate browser; it doesn't need to wait
        // for this one to finish tearing down first.
        lock.release()
        await close()
      }
    })()

    return { statusCode: 200, body: { productId, total: candidates.length } }
  }
}
