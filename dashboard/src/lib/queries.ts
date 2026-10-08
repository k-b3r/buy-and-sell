// Server-side data access for the dashboard.
//
// The SQL used to live here. It now lives in the feature modules
// (src/modules/*/queries.ts, settings in src/platform/settings.ts), on the
// box that owns the database: Postgres moved off Neon onto that VPS and
// listens on localhost only, so this app - running as Vercel Lambdas - has no
// route to it. Each function below names a query the server has whitelisted (see
// server/routes/query.ts) and gets rows back over the same authenticated
// tunnel /logs and /worker-control already use. No SQL crosses the network,
// so a leaked REFRESH_API_KEY can only run the queries this app ships.
//
// SERVER-ONLY. Everything here reads REFRESH_API_KEY and must never be
// imported by a client component - the pure pricing predicates a browser
// needs live in ./shared.generated.ts, which is safe to import anywhere.
//
// Adding a query means adding it to its module's queries.ts AND to that route's
// REGISTRY, then adding the wrapper here. The two packages share no import
// path: the row types come from ./shared.generated (scripts/gen-dashboard-shared.ts),
// re-exported here next to the calls that return them.

import type {
  CategoryWeeklySoldCounts,
  CollectKeyword,
  DealListing,
  DealsDiscountPolicyFloors,
  DealsFilters,
  DiscountNotification,
  ExcludedProduct,
  ExclusionReasonCount,
  ListingDetail,
  PeerMedianPrice,
  ProductDetail,
  ProductNeedingReview,
  ProductSummary,
  RealEstateFilters,
  RealEstateListing,
  SavedListingSummary,
  SettingRow,
  SoldComparablePrice,
  SubCategoryTreeEntry,
} from './shared.generated'

export type {
  CategoryWeeklySoldCounts,
  CollectKeyword,
  ComparableListing,
  DealListing,
  DealsConfidenceTier,
  DiscountNotification,
  ExcludedProduct,
  ExclusionReasonCount,
  ListingDetail,
  ProductDetail,
  ProductListingSummary,
  ProductNeedingReview,
  ProductPriceHistoryEntry,
  ProductReviewEnrichment,
  ProductSummary,
  SavedListingSummary,
  SubCategoryTreeEntry,
} from './shared.generated'

// One round trip per call. Most page loads never reach here - lib/
// cachedQueries.ts wraps the read paths in unstable_cache with a 300s TTL
// and tag-based busting, so this fires on a cache miss or a mutation, not
// on every render.
async function rpc<T>(name: string, args: unknown[] = []): Promise<T> {
  const baseUrl = process.env.REFRESH_SERVER_URL
  const apiKey = process.env.REFRESH_API_KEY
  if (!baseUrl || !apiKey) {
    throw new Error('REFRESH_SERVER_URL/REFRESH_API_KEY not set - the dashboard cannot reach the database without them')
  }

  const res = await fetch(`${baseUrl}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ name, args }),
    // Caching is cachedQueries.ts's job, keyed on real arguments - Next's
    // fetch cache would key on this URL+body and duplicate that badly.
    cache: 'no-store',
  })

  if (!res.ok) {
    throw new Error(`query ${name} failed: ${res.status}`)
  }
  const body = (await res.json()) as { result: T }
  return body.result
}

export function getProductSummaries(
  options: { search?: string; categories?: string[]; subCategories?: string[]; offset?: number; limit?: number } = {},
): Promise<ProductSummary[]> {
  return rpc('getProductSummaries', [options])
}

export function getSubCategoryTree(): Promise<SubCategoryTreeEntry[]> {
  return rpc('getSubCategoryTree')
}

export function getProductsNeedingReview(): Promise<ProductNeedingReview[]> {
  return rpc('getProductsNeedingReview')
}

export function setManualPrice(
  productId: number,
  price: { kind: 'new' | 'secondhand'; priceLow: number; priceHigh: number },
): Promise<void> {
  return rpc('setManualPrice', [productId, price])
}

export function markProductReviewed(productId: number): Promise<void> {
  return rpc('markProductReviewed', [productId])
}

export function excludeProductFromReview(productId: number, reason: string): Promise<void> {
  return rpc('excludeProductFromReview', [productId, reason])
}

export function includeInPricing(productId: number): Promise<void> {
  return rpc('includeInPricing', [productId])
}

export function getExclusionSummary(): Promise<ExclusionReasonCount[]> {
  return rpc('getExclusionSummary')
}

export function getExcludedProducts(
  reason: string,
  options: { offset?: number; limit?: number } = {},
): Promise<ExcludedProduct[]> {
  return rpc('getExcludedProducts', [reason, options])
}

// pricing.exclusions_ui_enabled (BUY-36): off hides every exclusion badge,
// page and button, today's behavior.
export async function isExclusionsUiEnabled(): Promise<boolean> {
  const settings = await getAllSettings()
  return settings.some((s) => s.key === 'pricing.exclusions_ui_enabled' && s.value === 1)
}

export function getProductDetail(productId: number): Promise<ProductDetail | null> {
  return rpc('getProductDetail', [productId])
}

export function getListingDetail(listingId: string): Promise<ListingDetail | null> {
  return rpc('getListingDetail', [listingId])
}

export function getSoldComparablePrice(productId: number): Promise<SoldComparablePrice | null> {
  return rpc('getSoldComparablePrice', [productId])
}

export function getPeerMedianPrice(productId: number): Promise<PeerMedianPrice | null> {
  return rpc('getPeerMedianPrice', [productId])
}

export function getDeals(
  discountPolicy: DealsDiscountPolicyFloors,
  filters: DealsFilters = {},
): Promise<DealListing[]> {
  return rpc('getDeals', [discountPolicy, filters])
}

export function saveListing(listingId: string): Promise<void> {
  return rpc('saveListing', [listingId])
}

export function unsaveListing(listingId: string): Promise<void> {
  return rpc('unsaveListing', [listingId])
}

export function getSoldCountsBySubCategory(): Promise<CategoryWeeklySoldCounts[]> {
  return rpc('getSoldCountsBySubCategory')
}

export function getSavedListings(): Promise<SavedListingSummary[]> {
  return rpc('getSavedListings')
}

export function getDiscountNotifications(limit?: number): Promise<DiscountNotification[]> {
  return rpc('getDiscountNotifications', limit === undefined ? [] : [limit])
}

export function getUnreadDiscountNotificationCount(): Promise<number> {
  return rpc('getUnreadDiscountNotificationCount')
}

export function markDiscountNotificationRead(id: number): Promise<void> {
  return rpc('markDiscountNotificationRead', [id])
}

export function markAllDiscountNotificationsRead(): Promise<void> {
  return rpc('markAllDiscountNotificationsRead')
}

export function getAllSettings(): Promise<SettingRow[]> {
  return rpc('getAllSettings')
}

export function updateSettings(updates: { key: string; value: number }[]): Promise<void> {
  return rpc('updateSettings', [updates])
}

export function getCollectKeywords(): Promise<CollectKeyword[]> {
  return rpc('getCollectKeywords')
}

export function replaceCollectKeywords(keywords: CollectKeyword[]): Promise<void> {
  return rpc('replaceCollectKeywords', [keywords])
}

export function getListingProductId(listingId: string): Promise<number | null> {
  return rpc('getListingProductId', [listingId])
}

export function getRealEstateListings(filters: RealEstateFilters = {}): Promise<RealEstateListing[]> {
  return rpc('getRealEstateListings', [filters])
}
