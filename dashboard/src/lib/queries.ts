// Server-side data access for the dashboard.
//
// The SQL lives in the feature modules (src/modules/*/queries.ts, settings in
// src/platform/settings.ts), on the box that owns the database: Postgres
// listens on the VPS's localhost only, so this app - running as Vercel
// Lambdas - has no route to it. Each function below calls one of the server's
// resource routes (src/modules/*/routes.ts, mounted by server/index.ts)
// through api() over an authenticated tunnel. No SQL crosses the network, and
// the server caches the reads itself (300 s TTL, tag invalidation).
//
// SERVER-ONLY. Everything here reads REFRESH_API_KEY and must never be
// imported by a client component - the pure pricing predicates a browser
// needs live in ./shared.generated.ts, which is safe to import anywhere.
//
// Adding a read means adding its route to the module's routes.ts, then the
// wrapper here. The two packages share no import path: the row types come
// from ./shared.generated (scripts/gen-dashboard-shared.ts), re-exported here
// next to the calls that return them.

import type {
  CategoryWeeklySoldCounts,
  DealListing,
  DealsFilters,
  ExcludedProduct,
  ExclusionReasonCount,
  ListingDetail,
  ListingsPage,
  ProductDetail,
  ProductNeedingReview,
  ProductSummary,
  RealEstateFilters,
  RealEstateListing,
  SavedListingSummary,
  SettingRow,
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

export async function getExclusionSummary(): Promise<ExclusionReasonCount[]> {
  const { summary } = await api<{ summary: ExclusionReasonCount[] }>('/price-exclusions/summary')
  return summary
}

export async function getExcludedProducts(
  reason: string,
  options: { offset?: number; limit?: number } = {},
): Promise<ExcludedProduct[]> {
  const params = new URLSearchParams({ reason })
  if (options.offset) params.set('offset', String(options.offset))
  if (options.limit) params.set('limit', String(options.limit))
  const { products } = await api<{ products: ExcludedProduct[] }>(`/price-exclusions?${params}`)
  return products
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

/** One page of ranked deals; the server applies the live discount-policy floors and fixes the page size. */
export function getDeals(
  filters: Omit<DealsFilters, 'limit'> = {},
): Promise<{ deals: DealListing[]; nextOffset: number | null }> {
  const params = new URLSearchParams()
  if (filters.search) params.set('search', filters.search)
  for (const category of filters.categories ?? []) params.append('category', category)
  if (filters.minProfitPesos !== undefined) params.set('minProfit', String(filters.minProfitPesos))
  if (filters.minConfidenceTier) params.set('minTier', filters.minConfidenceTier)
  if (filters.maxDaysListed !== undefined) params.set('maxDaysListed', String(filters.maxDaysListed))
  if (filters.addedWithinHours !== undefined) params.set('addedWithinHours', String(filters.addedWithinHours))
  if (filters.soldOnly) params.set('soldOnly', 'true')
  if (filters.lowConfidenceOnly) params.set('lowConfidence', 'true')
  if (filters.offset) params.set('offset', String(filters.offset))
  return api(`/deals?${params}`)
}

export async function getSoldCountsBySubCategory(): Promise<CategoryWeeklySoldCounts[]> {
  const { categories } = await api<{ categories: CategoryWeeklySoldCounts[] }>('/categories/sold-counts')
  return categories
}

export async function getSavedListings(): Promise<SavedListingSummary[]> {
  const { listings } = await api<{ listings: SavedListingSummary[] }>('/saved-listings')
  return listings
}

export async function getAllSettings(): Promise<SettingRow[]> {
  const { settings } = await api<{ settings: SettingRow[] }>('/settings')
  return settings
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
