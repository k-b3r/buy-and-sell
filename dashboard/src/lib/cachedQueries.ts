import { unstable_cache } from 'next/cache'
import { getProductSummaries, getProductDetail, getListingDetail, getSavedListings, getSoldCountsBySubCategory, getSubCategoryTree } from './queries'
import type {
  QueryClient,
  ProductSummary,
  ProductDetail,
  ListingDetail,
  SavedListingSummary,
  CategoryWeeklySoldCounts,
  SubCategoryTreeEntry,
} from './queries'

// Kept out of queries.ts on purpose: that module is imported directly by
// vitest (queries.test.ts), and next/cache's unstable_cache touches Next's
// request-scoped internals that don't exist outside a running Next server.
// db is closed over rather than passed as an arg to unstable_cache's
// fetcher - it's the same singleton for the whole deployment and doesn't
// affect query output, so it has no business being part of the cache key.

const REVALIDATE_SECONDS = 300

export function getProductSummariesCached(
  db: QueryClient,
  options: { search?: string; categories?: string[]; subCategories?: string[]; offset?: number; limit?: number } = {},
): Promise<ProductSummary[]> {
  const { search = '', categories = [], subCategories = [], offset = 0, limit } = options
  // Sorted-join so selection order never fragments the cache (['a','b'] and
  // ['b','a'] must hit the same entry).
  const categoryKey = [...categories].sort().join(',')
  const subCategoryKey = [...subCategories].sort().join(',')
  return unstable_cache(
    () => getProductSummaries(db, options),
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
export function getSubCategoryTreeCached(db: QueryClient): Promise<SubCategoryTreeEntry[]> {
  return unstable_cache(() => getSubCategoryTree(db), ['sub-category-tree'], {
    tags: ['categories'],
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

export function getSavedListingsCached(db: QueryClient): Promise<SavedListingSummary[]> {
  return unstable_cache(() => getSavedListings(db), ['saved-listings'], {
    tags: ['saved-listings'],
    revalidate: REVALIDATE_SECONDS,
  })()
}

export function getSoldCountsBySubCategoryCached(db: QueryClient): Promise<CategoryWeeklySoldCounts[]> {
  return unstable_cache(() => getSoldCountsBySubCategory(db), ['sold-counts-by-sub-category'], {
    tags: ['sold-listings'],
    revalidate: REVALIDATE_SECONDS,
  })()
}
