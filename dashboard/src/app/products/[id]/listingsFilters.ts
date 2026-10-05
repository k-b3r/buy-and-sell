// Plain module (no 'use client') - parseListingsFilters is called from
// ProductDetailPage (a Server Component) to seed ListingsView, and a client
// export can't be invoked from the server, so this logic can't live inside
// ListingsView.tsx itself despite being ListingsView-specific. paginateListings
// below is called from both page.tsx (SSR, first page) and the
// /api/products/[id]/listings route (subsequent pages) for the same reason.

import type { ProductListingSummary } from '../../../lib/queries'
import { isListingPriceNegotiable } from '../../../lib/pricing'
import { isInDiscountBand } from './discountBand'

export type View = 'list' | 'cards'
export type SortKey = 'discount_desc' | 'discount_asc' | 'price_asc' | 'price_desc' | 'listed_newest' | 'listed_oldest'

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'discount_desc', label: 'Discount: high to low' },
  { value: 'discount_asc', label: 'Discount: low to high' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'listed_newest', label: 'Listed: newest first' },
  { value: 'listed_oldest', label: 'Listed: oldest first' },
]

export const LISTED_WITHIN_OPTIONS = [
  { value: 0, label: 'Any time' },
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
]

// Filter defaults, not display-preference defaults (view/sort) - what
// ListingsView's "Clear" resets. hideSold defaults to true (the app's
// normal starting state, per direct instruction 2026-08-23), so Clear
// returns to that, not to "show everything."
export const DEFAULT_VIEW: View = 'cards'
export const DEFAULT_SORT_KEY: SortKey = 'discount_desc'
export const DEFAULT_LISTED_WITHIN_DAYS = 0
export const DEFAULT_HIDE_SOLD = true
export const DEFAULT_NEGOTIABLE_ONLY = false
export const DEFAULT_SELECTED_BAND = null

export interface ListingsFilters {
  view: View
  sortKey: SortKey
  listedWithinDays: number
  hideSold: boolean
  negotiableOnly: boolean
  selectedBand: number | null
}

export const DEFAULT_LISTINGS_FILTERS: ListingsFilters = {
  view: DEFAULT_VIEW,
  sortKey: DEFAULT_SORT_KEY,
  listedWithinDays: DEFAULT_LISTED_WITHIN_DAYS,
  hideSold: DEFAULT_HIDE_SOLD,
  negotiableOnly: DEFAULT_NEGOTIABLE_ONLY,
  selectedBand: DEFAULT_SELECTED_BAND,
}

// Whether ListingsView's "Clear" has anything to reset - view and sort are
// display preferences, not filters, so they never count.
export function hasActiveFilters(filters: ListingsFilters): boolean {
  return (
    filters.listedWithinDays !== DEFAULT_LISTED_WITHIN_DAYS ||
    filters.hideSold !== DEFAULT_HIDE_SOLD ||
    filters.negotiableOnly !== DEFAULT_NEGOTIABLE_ONLY ||
    filters.selectedBand !== DEFAULT_SELECTED_BAND
  )
}

// Parses the `back` querystring a listing link (ListingsView) carried, into
// the filter state it was built from - lets ProductDetailPage seed
// ListingsView with whatever was active before the user clicked into a
// listing, instead of always starting over at the hardcoded defaults
// (confirmed live 2026-08-29: clicking a listing then "Back to X" reset
// sort/hide-sold/discount-band/etc. every time - this component had no URL
// awareness at all, unlike the outer product list's category/sub-category
// filters).
export function parseListingsFilters(params: URLSearchParams): ListingsFilters {
  const sortParam = params.get('sort')
  const bandParam = params.get('band')
  const parsedBand = bandParam !== null ? Number(bandParam) : NaN
  return {
    view: params.get('view') === 'list' ? 'list' : DEFAULT_VIEW,
    sortKey: SORT_OPTIONS.some((o) => o.value === sortParam) ? (sortParam as SortKey) : DEFAULT_SORT_KEY,
    listedWithinDays: LISTED_WITHIN_OPTIONS.some((o) => o.value === Number(params.get('listedWithin')))
      ? Number(params.get('listedWithin'))
      : DEFAULT_LISTED_WITHIN_DAYS,
    hideSold: params.has('hideSold') ? params.get('hideSold') === '1' : DEFAULT_HIDE_SOLD,
    negotiableOnly: params.get('negotiable') === '1',
    selectedBand: Number.isFinite(parsedBand) ? parsedBand : DEFAULT_SELECTED_BAND,
  }
}

// Inverse of parseListingsFilters - only writes params that differ from the
// default, so an unfiltered view still links to a bare `/listings/${id}`.
export function buildListingsQueryString(filters: ListingsFilters): string {
  const params = new URLSearchParams()
  if (filters.view !== DEFAULT_VIEW) params.set('view', filters.view)
  if (filters.sortKey !== DEFAULT_SORT_KEY) params.set('sort', filters.sortKey)
  if (filters.listedWithinDays !== DEFAULT_LISTED_WITHIN_DAYS)
    params.set('listedWithin', String(filters.listedWithinDays))
  if (filters.hideSold !== DEFAULT_HIDE_SOLD) params.set('hideSold', filters.hideSold ? '1' : '0')
  if (filters.negotiableOnly !== DEFAULT_NEGOTIABLE_ONLY) params.set('negotiable', '1')
  if (filters.selectedBand !== DEFAULT_SELECTED_BAND) params.set('band', String(filters.selectedBand))
  return params.toString()
}

// Carries the filters as `?back=` so that listing's "Back to {product}"
// button (ListingDetailContent) returns to ListingsView with these same
// filters applied, instead of the product page resetting to its defaults.
export function listingDetailHref(listingId: string, filters: ListingsFilters): string {
  const backQueryString = buildListingsQueryString(filters)
  return backQueryString
    ? `/listings/${listingId}?back=${encodeURIComponent(backQueryString)}`
    : `/listings/${listingId}`
}

// Nulls always sort last, regardless of direction - a listing with no
// discount/date data shouldn't jump to the front just because "low to high"
// treats null as 0.
function compareNullableNumbers(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return (a - b) * direction
}

export function sortListings<T extends ProductListingSummary>(listings: T[], sortKey: SortKey): T[] {
  const sorted = [...listings]
  switch (sortKey) {
    case 'discount_desc':
      return sorted.sort((a, b) => compareNullableNumbers(a.discount_percent, b.discount_percent, -1))
    case 'discount_asc':
      return sorted.sort((a, b) => compareNullableNumbers(a.discount_percent, b.discount_percent, 1))
    case 'price_asc':
      return sorted.sort((a, b) => compareNullableNumbers(a.price_amount, b.price_amount, 1))
    case 'price_desc':
      return sorted.sort((a, b) => compareNullableNumbers(a.price_amount, b.price_amount, -1))
    case 'listed_newest':
      return sorted.sort((a, b) =>
        compareNullableNumbers(
          a.listed_at ? Date.parse(a.listed_at) : null,
          b.listed_at ? Date.parse(b.listed_at) : null,
          -1,
        ),
      )
    case 'listed_oldest':
      return sorted.sort((a, b) =>
        compareNullableNumbers(
          a.listed_at ? Date.parse(a.listed_at) : null,
          b.listed_at ? Date.parse(b.listed_at) : null,
          1,
        ),
      )
  }
}

export function filterListings<T extends ProductListingSummary>(
  listings: T[],
  listedWithinDays: number,
  hideSold: boolean,
  negotiableOnly: boolean,
  selectedBand: number | null,
): T[] {
  return listings.filter((l) => {
    if (hideSold && l.sold_at) return false
    if (negotiableOnly && !isListingPriceNegotiable(l.price_amount, l.price_review, l.discount_percent)) return false
    if (selectedBand !== null && !isInDiscountBand(l.discount_percent, selectedBand)) return false
    if (listedWithinDays > 0) {
      if (!l.listed_at) return false
      const cutoff = Date.now() - listedWithinDays * 24 * 60 * 60 * 1000
      if (Date.parse(l.listed_at) < cutoff) return false
    }
    return true
  })
}

export const LISTINGS_PAGE_SIZE = 30

// is_repost comes from the server (pricing's computeRepostIds over the
// product's FULL listing set), so filtering/paging here can't change it.
export type PaginatedListingSummary = ProductListingSummary

export interface ListingsPage {
  listings: PaginatedListingSummary[]
  nextOffset: number | null
  matchedCount: number
  allIds: string[]
}

// allIds is computed over the full filtered/sorted set (cheap - just ids) so
// the listing-detail modal's prev/next cycling still spans every matching
// listing, not just whatever pages happen to be loaded client-side.
export function paginateListings(
  listings: ProductListingSummary[],
  filters: ListingsFilters,
  offset: number,
): ListingsPage {
  const visible = sortListings(
    filterListings(listings, filters.listedWithinDays, filters.hideSold, filters.negotiableOnly, filters.selectedBand),
    filters.sortKey,
  )
  const page = visible.slice(offset, offset + LISTINGS_PAGE_SIZE)
  const nextOffset = offset + LISTINGS_PAGE_SIZE < visible.length ? offset + LISTINGS_PAGE_SIZE : null
  return { listings: page, nextOffset, matchedCount: visible.length, allIds: visible.map((l) => l.id) }
}
