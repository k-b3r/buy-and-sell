import { isListingPriceNegotiable } from '../pricing'
import type { ProductListingSummary } from './product-detail'
import type { ListingsFilters, ListingSortKey } from './schemas'

// Filter, sort and page one product's listings for the dashboard's listings
// view. Runs over the product's FULL listing set (the cached product detail),
// so is_repost and the discount figures were computed before any of this and
// can't change here.

export const LISTINGS_PAGE_SIZE = 30
const DAY_MS = 24 * 60 * 60 * 1000

export interface ListingsPage {
  listings: ProductListingSummary[]
  nextOffset: number | null
  matchedCount: number
  allIds: string[]
}

// Bands are decade-wide floors (10, 20, ...), see summarizeDiscounts in
// pricing/domain/price-rules.ts: a listing belongs to a band if its percent falls in
// [bandFloor, bandFloor + 10).
function isInDiscountBand(percent: number | null, bandFloor: number): boolean {
  return percent !== null && percent >= bandFloor && percent < bandFloor + 10
}

// Nulls always sort last, regardless of direction: a listing with no
// discount/date data shouldn't jump to the front just because "low to high"
// treats null as 0.
function compareNullable(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return (a - b) * direction
}

const listedAtMs = (l: ProductListingSummary): number | null => (l.listed_at ? Date.parse(l.listed_at) : null)

const COMPARATORS: Record<ListingSortKey, (a: ProductListingSummary, b: ProductListingSummary) => number> = {
  discount_desc: (a, b) => compareNullable(a.discount_percent, b.discount_percent, -1),
  discount_asc: (a, b) => compareNullable(a.discount_percent, b.discount_percent, 1),
  price_asc: (a, b) => compareNullable(a.price_amount, b.price_amount, 1),
  price_desc: (a, b) => compareNullable(a.price_amount, b.price_amount, -1),
  listed_newest: (a, b) => compareNullable(listedAtMs(a), listedAtMs(b), -1),
  listed_oldest: (a, b) => compareNullable(listedAtMs(a), listedAtMs(b), 1),
}

function matchesFilters(l: ProductListingSummary, f: ListingsFilters, now: number): boolean {
  if (f.hideSold && l.sold_at) return false
  if (f.negotiableOnly && !isListingPriceNegotiable(l.price_amount, l.price_review, l.discount_percent)) return false
  if (f.selectedBand !== null && !isInDiscountBand(l.discount_percent, f.selectedBand)) return false
  if (f.listedWithinDays > 0) {
    const listed = listedAtMs(l)
    if (listed === null || listed < now - f.listedWithinDays * DAY_MS) return false
  }
  return true
}

// allIds spans the full filtered/sorted set (cheap, just ids) so the
// listing-detail modal's prev/next cycling covers every match, not only the
// pages loaded so far.
export function paginateListings(
  listings: ProductListingSummary[],
  filters: ListingsFilters,
  offset: number,
  now: number = Date.now(),
): ListingsPage {
  const visible = listings.filter((l) => matchesFilters(l, filters, now)).sort(COMPARATORS[filters.sortKey])
  const end = offset + LISTINGS_PAGE_SIZE
  return {
    listings: visible.slice(offset, end),
    nextOffset: end < visible.length ? end : null,
    matchedCount: visible.length,
    allIds: visible.map((l) => l.id),
  }
}
