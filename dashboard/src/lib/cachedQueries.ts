import { unstable_cache } from 'next/cache'
import {
  getProductSummaries,
  getProductDetail,
  getListingDetail,
  getSavedListings,
  getSoldCountsBySubCategory,
  getSubCategoryTree,
  getProductsNeedingReview,
} from './queries'
import type {
  ProductSummary,
  ProductDetail,
  ListingDetail,
  SavedListingSummary,
  CategoryWeeklySoldCounts,
  SubCategoryTreeEntry,
  ProductNeedingReview,
} from './queries'

// Kept out of queries.ts on purpose: that module is imported directly by
// vitest (queries.test.ts), and next/cache's unstable_cache touches Next's
// request-scoped internals that don't exist outside a running Next server.
// The wrapped functions are RPC calls to server/ now (see queries.ts), so
// there's no connection handle to thread through - only real arguments,
// which are exactly what the cache key should be built from.

const REVALIDATE_SECONDS = 300

export function getProductSummariesCached(
  options: { search?: string; categories?: string[]; subCategories?: string[]; offset?: number; limit?: number } = {},
): Promise<ProductSummary[]> {
  const { search = '', categories = [], subCategories = [], offset = 0, limit } = options
  // Sorted-join so selection order never fragments the cache (['a','b'] and
  // ['b','a'] must hit the same entry).
  const categoryKey = [...categories].sort().join(',')
  const subCategoryKey = [...subCategories].sort().join(',')
  return unstable_cache(
    () => getProductSummaries(options),
    ['product-summaries', search, categoryKey, subCategoryKey, String(offset), String(limit)],
    {
      tags: ['products-list'],
      revalidate: REVALIDATE_SECONDS,
    },
  )()
}

// Sub-category tree is static (categories.parent_id seeding, not per-user
// input) - no revalidate window needed, just a tag so it can be busted
// alongside the rest of the categories table if that ever gets re-seeded.
export function getSubCategoryTreeCached(): Promise<SubCategoryTreeEntry[]> {
  return unstable_cache(() => getSubCategoryTree(), ['sub-category-tree'], {
    tags: ['categories'],
  })()
}

export function getProductDetailCached(productId: number): Promise<ProductDetail | null> {
  return unstable_cache(() => getProductDetail(productId), ['product-detail', String(productId)], {
    tags: [`product:${productId}`],
    revalidate: REVALIDATE_SECONDS,
  })()
}

export function getListingDetailCached(listingId: string): Promise<ListingDetail | null> {
  return unstable_cache(() => getListingDetail(listingId), ['listing-detail', listingId], {
    tags: [`listing:${listingId}`],
    revalidate: REVALIDATE_SECONDS,
  })()
}

export function getSavedListingsCached(): Promise<SavedListingSummary[]> {
  return unstable_cache(() => getSavedListings(), ['saved-listings'], {
    tags: ['saved-listings'],
    revalidate: REVALIDATE_SECONDS,
  })()
}

export function getSoldCountsBySubCategoryCached(): Promise<CategoryWeeklySoldCounts[]> {
  return unstable_cache(() => getSoldCountsBySubCategory(), ['sold-counts-by-sub-category'], {
    tags: ['sold-listings'],
    revalidate: REVALIDATE_SECONDS,
  })()
}

export function getProductsNeedingReviewCached(): Promise<ProductNeedingReview[]> {
  return unstable_cache(() => getProductsNeedingReview(), ['products-needing-review'], {
    tags: ['needs-review'],
    revalidate: REVALIDATE_SECONDS,
  })()
}
