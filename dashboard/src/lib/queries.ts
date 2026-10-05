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
// needs live in ./pricing.ts, which is safe to import anywhere.
//
// Adding a query means adding it to its module's queries.ts AND to that route's
// REGISTRY, then adding the wrapper here. Types below are duplicated from
// the modules' queries.ts by hand - the two packages share no import path.

import type { DiscountBand, ListingPriceReview } from './pricing'

export type { DiscountBand, DiscountSummary, ListingPriceReview } from './pricing'

export interface ProductSummary {
  id: number
  base_model: string
  variant_tier: string | null
  category: string | null
  sub_category: string | null
  listing_count: number
  price_min: number | null
  price_max: number | null
  price_avg: number | null
  sample_photo_url: string | null
  new_price_low: number | null
  new_price_high: number | null
  secondhand_price_low: number | null
  secondhand_price_high: number | null
  secondhand_price_source: string | null
  best_discount_percent: number | null
  discounted_listing_count: number
  discount_bands: DiscountBand[]
}

export interface SubCategoryTreeEntry {
  subCategory: string
  parentCategory: string
}

export interface ProductReviewEnrichment {
  description: string
  value_drivers: string
  has_trained_price_knowledge: boolean
  trained_price_low: number | null
  trained_price_high: number | null
  trained_price_currency: string | null
  model: string
  checked_at: string
  confidence: string | null
  is_specific_product: boolean | null
}

export interface ProductPriceHistoryEntry {
  id: number
  kind: 'new' | 'secondhand'
  price_low: number | null
  price_high: number | null
  price_currency: string | null
  source: string
  condition: string | null
  checked_at: string
}

export interface ProductNeedingReview {
  id: number
  base_model: string
  variant_tier: string | null
  category: string | null
  sub_category: string | null
  sample_photo_url: string | null
  new_price_low: number | null
  new_price_high: number | null
  secondhand_price_low: number | null
  secondhand_price_high: number | null
  price_history: ProductPriceHistoryEntry[]
  enrichment: ProductReviewEnrichment | null
}

export interface ProductListingSummary {
  id: string
  title: string
  price_amount: number | null
  primary_photo_url: string | null
  condition: string | null
  sold_at: string | null
  listed_at: string | null
  price_review: ListingPriceReview | null
  discount_percent: number | null
  reference_price: number | null
  is_saved: boolean
  // The model's own reasoning for why this exact listing cleared the
  // verification gate (discount-verification.ts's VerificationOutcome,
  // 'verified' case) - null for any listing that never got a verified
  // discount_notifications row, not just an unflagged one.
  verification_reasoning: string | null
}

export interface ProductEnrichment {
  description: string
  value_drivers: string
  has_trained_price_knowledge: boolean
  trained_price_low: number | null
  trained_price_high: number | null
  trained_price_currency: string | null
  model: string
  checked_at: string
}

export interface ProductDetail {
  id: number
  base_model: string
  variant_tier: string | null
  new_price_low: number | null
  new_price_high: number | null
  secondhand_price_low: number | null
  secondhand_price_high: number | null
  secondhand_price_source: string | null
  best_discount_percent: number | null
  discounted_listing_count: number
  discount_bands: DiscountBand[]
  enrichment: ProductEnrichment | null
  listings: ProductListingSummary[]
}

export interface ListingDetail {
  id: string
  title: string
  price_amount: number | null
  price_currency: string | null
  description: string | null
  condition: string | null
  location_city: string | null
  listed_at: string | null
  last_seen_at: string | null
  photo_urls: string[]
  product_id: number | null
  base_model: string | null
  variant_tier: string | null
  sold_at: string | null
  price_review: ListingPriceReview | null
  discount_percent: number | null
  reference_price: number | null
  is_saved: boolean
  verification_reasoning: string | null
  recent_sales: ComparableListing[]
  similar_listings: ComparableListing[]
}

export interface SoldComparablePrice {
  medianPrice: number
  sampleSize: number
}

export interface PeerMedianPrice {
  medianPrice: number
  sampleSize: number
}

export interface ComparableListing {
  listing_id: string
  title: string
  price_amount: number
  photo_url: string | null
  date: string | null
}

export type DealsConfidenceTier = 'sold_comps' | 'peer_listings' | 'llm_estimate'

export interface DealListing {
  listing_id: string
  title: string
  ask_price: number
  photo_url: string | null
  product_id: number | null
  base_model: string | null
  variant_tier: string | null
  category: string | null
  sub_category: string | null
  reference_price: number | null
  tier: DealsConfidenceTier | null
  // Count of comparable listings behind the winning tier - sold listings for
  // sold_comps, active peer listings for peer_listings, null for
  // llm_estimate (nothing to count) or no tier at all.
  comp_count: number | null
  profit_pesos: number | null
  discount_percent: number | null
  days_listed: number | null
  is_saved: boolean
  is_low_confidence: boolean
}

export interface DealsDiscountPolicyFloors {
  minProfitPesos: number
  minPricePesos: number
}

export interface DealsFilters {
  search?: string
  categories?: string[]
  minProfitPesos?: number
  minConfidenceTier?: DealsConfidenceTier
  maxDaysListed?: number
  soldOnly?: boolean
  lowConfidenceOnly?: boolean
  offset?: number
  limit?: number
}

export interface SavedListingSummary {
  id: string
  title: string
  price_amount: number | null
  primary_photo_url: string | null
  condition: string | null
  sold_at: string | null
  product_id: number | null
  base_model: string | null
  variant_tier: string | null
  saved_at: string
}

export interface CategoryWeeklySoldCounts {
  category: string
  subCategory: string
  totalSold: number
  weeklyCounts: { weekStart: string; count: number; avgPrice: number | null }[]
}

export interface DiscountNotification {
  id: number
  listing_id: string
  product_id: number
  title: string | null
  primary_photo_url: string | null
  discount_percent: number
  reference_price: number
  created_at: string
  read_at: string | null
  verification_reasoning: string | null
}

export interface SettingRow {
  key: string
  value: number
  updatedAt: string
}

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
  kind: 'new' | 'secondhand',
  priceLow: number,
  priceHigh: number,
): Promise<void> {
  return rpc('setManualPrice', [productId, kind, priceLow, priceHigh])
}

export function markProductReviewed(productId: number): Promise<void> {
  return rpc('markProductReviewed', [productId])
}

export function excludeProductFromReview(productId: number, reason: string): Promise<void> {
  return rpc('excludeProductFromReview', [productId, reason])
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

export function getComparableListings(
  productId: number,
  excludeListingId: string,
  sold: boolean,
  limit?: number,
): Promise<ComparableListing[]> {
  return rpc(
    'getComparableListings',
    limit === undefined ? [productId, excludeListingId, sold] : [productId, excludeListingId, sold, limit],
  )
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

export interface CollectKeyword {
  keyword: string
  enabled: boolean
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

// Duplicated from src/modules/real-estate/queries.ts by hand (no shared import path).
export interface RealEstateFilters {
  listingType?: 'sale' | 'rent'
  propertyType?: string
  area?: string
  project?: string
  minPrice?: number
  maxPrice?: number
  minSqm?: number
  sort?: 'newest' | 'price_asc' | 'price_desc' | 'ppsqm_asc'
  view?: 'main' | 'review'
  includeRoomShares?: boolean
  limit?: number
  offset?: number
}

export interface RealEstateListing {
  id: string
  title: string
  primary_photo_url: string | null
  listed_at: string | null
  first_seen_at: string
  listed_price: number | null
  listing_type: 'sale' | 'rent' | null
  property_type: string
  price_php: number | null
  price_basis: string
  lot_sqm: number | null
  floor_sqm: number | null
  bedrooms: number | null
  bathrooms: number | null
  project_name: string | null
  area_text: string | null
  tags: string[]
  confidence: string
  price_per_sqm: number | null
  needs_review: boolean
}

export function getRealEstateListings(filters: RealEstateFilters = {}): Promise<RealEstateListing[]> {
  return rpc('getRealEstateListings', [filters])
}
