import { unstable_cache } from 'next/cache'
import { getProductSummaries, getProductDetail, getListingDetail } from './queries'
import type { QueryClient, ProductSummary, ProductDetail, ListingDetail } from './queries'

// Kept out of queries.ts on purpose: that module is imported directly by
// vitest (queries.test.ts), and next/cache's unstable_cache touches Next's
// request-scoped internals that don't exist outside a running Next server.
// db is closed over rather than passed as an arg to unstable_cache's
// fetcher - it's the same singleton for the whole deployment and doesn't
// affect query output, so it has no business being part of the cache key.

const REVALIDATE_SECONDS = 300

export function getProductSummariesCached(
  db: QueryClient,
  options: { search?: string; category?: string; offset?: number; limit?: number } = {},
): Promise<ProductSummary[]> {
  const { search = '', category = '', offset = 0, limit } = options
  return unstable_cache(() => getProductSummaries(db, options), ['product-summaries', search, category, String(offset), String(limit)], {
    tags: ['products-list'],
    revalidate: REVALIDATE_SECONDS,
  })()
}

export function getProductDetailCached(db: QueryClient, productId: number): Promise<ProductDetail | null> {
  return unstable_cache(() => getProductDetail(db, productId), ['product-detail', String(productId)], {
    tags: [`product:${productId}`],
    revalidate: REVALIDATE_SECONDS,
  })()
}

export function getListingDetailCached(db: QueryClient, listingId: string): Promise<ListingDetail | null> {
  return unstable_cache(() => getListingDetail(db, listingId), ['listing-detail', listingId], {
    tags: [`listing:${listingId}`],
    revalidate: REVALIDATE_SECONDS,
  })()
}
