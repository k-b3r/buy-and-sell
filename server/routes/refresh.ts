import type { CacheInvalidator } from '../../src/platform/cache'
import type { DelayFn } from '../../src/platform/delay'
import type { Logger } from '../../src/platform/logger'
import type { QueryClient } from '../../src/platform/storage'
import { getListingCheckCandidate, getListingProductId } from '../../src/modules/collection'
import { checkOneListing } from '../../src/modules/collection'
import type { DriverFactory, ListingPhotos } from '../../src/modules/collection'
import type { RouteHandler, RouteResult } from '../app'
import type { RefreshPacer } from '../refreshPacer'
import type { TunnelCheckResult } from '../proxyGuard'
import { loadSettings } from '../../src/platform/settings'

// Dashboard's "Refresh" button (on-demand, one listing at a time) lands here
// rather than the batch getCheckListingsCandidates backlog - see checkOneListing
// for the shared core logic. Auth/JSON-parsing/routing already happened
// (see ../app.ts) by the time this runs - it only ever sees a parsed body.
export interface RefreshDeps {
  db: QueryClient
  photos: ListingPhotos
  logger: Logger
  delay: DelayFn
  pacer: RefreshPacer
  driverFactory: DriverFactory
  tunnelCheck: () => Promise<TunnelCheckResult>
  // Refreshes rewrite listing and product rows, so the reads cached by the
  // resource routes are dropped here, where the write happens.
  cache: CacheInvalidator
}

export function createRefreshHandler(deps: RefreshDeps): RouteHandler {
  const { db, photos, logger, delay, pacer, driverFactory, tunnelCheck, cache } = deps
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
    // first. See proxyGuard.ts: no action is taken on the listing at all
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

    let status: string
    try {
      const { driver, close } = await driverFactory(tunnel.proxy)
      try {
        logger.info(`on-demand refresh: listing ${id}`)
        await driver.openListing({ id })
        const settings = await loadSettings(db, ['check_listings.soft_wall_timeout_ms'])
        const result = await checkOneListing(
          { driver, db, photos, logger, delay },
          candidate,
          settings['check_listings.soft_wall_timeout_ms'],
        )
        status = result.status
      } finally {
        await close()
      }
    } finally {
      pacer.recordActionComplete()
      pacer.release()
    }

    // After the pacer is released: the lookup must not hold up the next
    // queued refresh. A failed lookup only leaves the product's cached page to
    // its TTL, so it must not turn a finished refresh into an error.
    cache.invalidate(`listing:${id}`, 'products-list')
    const productId = await getListingProductId(db, id).catch(() => null)
    if (productId !== null) cache.invalidate(`product:${productId}`)
    return { statusCode: 200, body: { status } }
  }
}
