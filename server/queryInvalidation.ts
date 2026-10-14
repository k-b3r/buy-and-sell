import type { RouteHandler } from './app'
import type { Cache } from './cache'

// Interim bridge, removed as each feature gets its own resource route.
//
// The catalog reads are cached in this process now (src/modules/catalog/
// routes.ts), but the refresh endpoints don't know about the cache. They used
// to revalidateTag on the dashboard's unstable_cache, which no longer holds
// those entries, so the server drops the stale ones itself, keyed off the
// request and the successful result.
//
// Delete an entry here when its endpoint moves to a router that calls
// cache.invalidate itself (BUY-82 for the refresh endpoints).

type Invalidator = Pick<Cache, 'invalidate'>

function productTags(productId: number): string[] {
  return ['products-list', `product:${productId}`]
}

/**
 * GET /refresh-job: a finished (or cancelled, which can still have written
 * some listings) bulk job changed its product, so drop that product's caches.
 * Idempotent, so it is fine to run on every poll that sees the final status.
 */
export function invalidateAfterJobStatus(handler: RouteHandler, cache: Invalidator): RouteHandler {
  return async (body) => {
    const result = await handler(body)
    const job = result.body as { productId?: unknown; status?: unknown } | null
    const finished = job?.status === 'completed' || job?.status === 'cancelled'
    if (finished && typeof job?.productId === 'number') cache.invalidate(...productTags(job.productId))
    return result
  }
}

/** POST /refresh: a re-checked listing changes its product's page and the list. */
export function invalidateAfterListingRefresh(
  handler: RouteHandler,
  cache: Invalidator,
  getProductId: (listingId: string) => Promise<number | null>,
): RouteHandler {
  return async (body) => {
    const result = await handler(body)
    const id = (body as { id?: unknown } | null)?.id
    if (result.statusCode !== 200 || typeof id !== 'string') return result
    cache.invalidate('products-list')
    // The refresh itself succeeded; a failed lookup only leaves the product
    // page to the 300 s TTL, so it must not turn the response into an error.
    const productId = await getProductId(id).catch(() => null)
    if (productId !== null) cache.invalidate(...productTags(productId))
    return result
  }
}
