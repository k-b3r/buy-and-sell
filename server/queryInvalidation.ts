import type { RouteHandler } from './app'
import type { Cache } from './cache'

// Interim bridge, removed as each feature gets its own resource route.
//
// The catalog reads are cached in this process now (src/modules/catalog/
// routes.ts), but some mutations still enter through paths that don't know
// about the cache: the Next handlers that call POST /query. They used to
// revalidateTag on the dashboard's unstable_cache, which no longer holds those
// entries, so the server drops the stale ones itself, keyed off the request
// and the successful result.
//
// Delete an entry here when its mutation moves to a router that calls
// cache.invalidate itself (BUY-79 for the product mutations). The refresh
// handlers already do (routes/refresh.ts, routes/refreshProduct.ts).

type Invalidator = Pick<Cache, 'invalidate'>

const PRODUCT_MUTATIONS = new Set(['setManualPrice', 'excludeProductFromReview', 'includeInPricing'])

function productIdOf(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null
  const { name, args } = body as { name?: unknown; args?: unknown }
  if (typeof name !== 'string' || !PRODUCT_MUTATIONS.has(name) || !Array.isArray(args)) return null
  return Number.isInteger(args[0]) ? (args[0] as number) : null
}

function productTags(productId: number): string[] {
  return ['products-list', `product:${productId}`]
}

/** POST /query: after a successful product mutation, drop its catalog caches. */
export function invalidateAfterQuery(handler: RouteHandler, cache: Invalidator): RouteHandler {
  return async (body) => {
    const result = await handler(body)
    const productId = productIdOf(body)
    if (result.statusCode === 200 && productId !== null) {
      cache.invalidate('needs-review', ...productTags(productId))
    }
    return result
  }
}
