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
  DealListing,
  DealsDiscountPolicyFloors,
  DealsFilters,
  DiscountNotification,
  ExcludedProduct,
  ExclusionReasonCount,
  ListingDetail,
  ListingsPage,
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
import { api } from './api'

export type {
  CategoryWeeklySoldCounts,
  ComparableListing,
  DealListing,
  DealsConfidenceTier,
  DiscountNotification,
  ExcludedProduct,
  ExclusionReasonCount,
  ListingDetail,
  ListingsPage,
  ProductDetail,
  ProductListingSummary,
  ProductNeedingReview,
  ProductPriceHistoryEntry,
  ProductReviewEnrichment,
  ProductSummary,
  SavedListingSummary,
  SubCategoryTreeEntry,
} from './shared.generated'

// One round trip per call. Reads the server caches itself (300s TTL, tag
// invalidation) are on api() above; this POST /query path is what is left.
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
    // Caching is the server's job - Next's fetch cache would key on this
    // URL+body and duplicate that badly.
    cache: 'no-store',
  })

  if (!res.ok) {
    throw new Error(`query ${name} failed: ${res.status}`)
  }
  const body = (await res.json()) as { result: T }
  return body.result
}

/** One page of the product list (the server fixes the page size). */
export function getProductSummaries(
  options: { search?: string; categories?: string[]; subCategories?: string[]; offset?: number } = {},
): Promise<{ products: ProductSummary[]; nextOffset: number | null }> {
  const params = new URLSearchParams()
  if (options.search) params.set('q', options.search)
  for (const category of options.categories ?? []) params.append('category', category)
  for (const subCategory of options.subCategories ?? []) params.append('subCategory', subCategory)
  if (options.offset) params.set('offset', String(options.offset))
  return api(`/products?${params}`)
}

export async function getSubCategoryTree(): Promise<SubCategoryTreeEntry[]> {
  const { tree } = await api<{ tree: SubCategoryTreeEntry[] }>('/categories/tree')
  return tree
}

export async function getProductsNeedingReview(): Promise<ProductNeedingReview[]> {
  const { products } = await api<{ products: ProductNeedingReview[] }>('/review-queue')
  return products
}

export function setManualPrice(
  productId: number,
  price: { kind: 'new' | 'secondhand'; priceLow: number; priceHigh: number },
): Promise<void> {
  return rpc('setManualPrice', [productId, price])
}

export async function markProductReviewed(productId: number): Promise<void> {
  await api(`/products/${productId}/mark-reviewed`, { method: 'POST' })
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

export async function getProductDetail(productId: number): Promise<ProductDetail | null> {
  const { product } = await api<{ product: ProductDetail | null }>(`/products/${productId}`)
  return product
}

/** First page of a product's listings; `queryString` is buildListingsQueryString's output. */
export function getProductListingsPage(productId: number, queryString: string): Promise<ListingsPage> {
  return api(`/products/${productId}/listings?${queryString}`)
}

export async function getListingDetail(listingId: string): Promise<ListingDetail | null> {
  const { listing } = await api<{ listing: ListingDetail | null }>(`/listings/${encodeURIComponent(listingId)}`)
  return listing
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

export async function getSoldCountsBySubCategory(): Promise<CategoryWeeklySoldCounts[]> {
  const { categories } = await api<{ categories: CategoryWeeklySoldCounts[] }>('/categories/sold-counts')
  return categories
}

export async function getSavedListings(): Promise<SavedListingSummary[]> {
  const { listings } = await api<{ listings: SavedListingSummary[] }>('/saved-listings')
  return listings
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

export async function getAllSettings(): Promise<SettingRow[]> {
  const { settings } = await api<{ settings: SettingRow[] }>('/settings')
  return settings
}

export function getListingProductId(listingId: string): Promise<number | null> {
  return rpc('getListingProductId', [listingId])
}

// Filter field -> the URL param GET /real-estate (and /api/real-estate) reads.
const REAL_ESTATE_PARAMS = [
  ['listingType', 'kind'],
  ['propertyType', 'type'],
  ['area', 'area'],
  ['project', 'project'],
  ['minPrice', 'min'],
  ['maxPrice', 'max'],
  ['minSqm', 'sqm'],
  ['sort', 'sort'],
  ['view', 'view'],
] as const

export async function getRealEstateListings(filters: RealEstateFilters = {}): Promise<RealEstateListing[]> {
  const query = new URLSearchParams()
  for (const [field, param] of REAL_ESTATE_PARAMS) {
    const value = filters[field]
    if (value !== undefined) query.set(param, String(value))
  }
  if (filters.includeRoomShares) query.set('rooms', '1')
  // The server owns the page size; only the page number crosses the wire.
  const pageSize = filters.limit ?? 30
  query.set('page', String(Math.floor((filters.offset ?? 0) / pageSize) + 1))
  const { listings } = await api<{ listings: RealEstateListing[] }>(`/real-estate?${query}`)
  return listings
}
