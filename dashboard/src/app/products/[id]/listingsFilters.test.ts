import { expect, test } from 'vitest'
import {
  paginateListings,
  DEFAULT_HIDE_SOLD,
  DEFAULT_NEGOTIABLE_ONLY,
  DEFAULT_LISTED_WITHIN_DAYS,
  DEFAULT_SELECTED_BAND,
  DEFAULT_SORT_KEY,
  type ListingsFilters,
} from './listingsFilters'
import type { ProductListingSummary } from '../../../lib/queries'

const DEFAULT_FILTERS: ListingsFilters = {
  view: 'cards',
  sortKey: DEFAULT_SORT_KEY,
  listedWithinDays: DEFAULT_LISTED_WITHIN_DAYS,
  hideSold: DEFAULT_HIDE_SOLD,
  negotiableOnly: DEFAULT_NEGOTIABLE_ONLY,
  selectedBand: DEFAULT_SELECTED_BAND,
}

function makeListing(overrides: Partial<ProductListingSummary> & { id: string }): ProductListingSummary {
  return {
    title: 'Listing',
    price_amount: 100,
    primary_photo_url: null,
    condition: null,
    sold_at: null,
    listed_at: null,
    price_review: null,
    discount_percent: null,
    reference_price: null,
    is_saved: false,
    verification_reasoning: null,
    ...overrides,
  }
}

test('paginateListings returns the first page sorted by discount desc by default', () => {
  const listings = [
    makeListing({ id: 'a', discount_percent: 10 }),
    makeListing({ id: 'b', discount_percent: 30 }),
    makeListing({ id: 'c', discount_percent: 20 }),
  ]
  const page = paginateListings(listings, DEFAULT_FILTERS, 0)
  expect(page.listings.map((l) => l.id)).toEqual(['b', 'c', 'a'])
})

test('paginateListings slices to LISTINGS_PAGE_SIZE and sets nextOffset when more remain', () => {
  const listings = Array.from({ length: 35 }, (_, i) => makeListing({ id: String(i), discount_percent: i }))
  const page = paginateListings(listings, DEFAULT_FILTERS, 0)
  expect(page.listings).toHaveLength(30)
  expect(page.nextOffset).toBe(30)
})

test('paginateListings returns nextOffset null exactly when the last page is reached', () => {
  const listings = Array.from({ length: 35 }, (_, i) => makeListing({ id: String(i), discount_percent: i }))
  const page = paginateListings(listings, DEFAULT_FILTERS, 30)
  expect(page.listings).toHaveLength(5)
  expect(page.nextOffset).toBeNull()
})

test('paginateListings returns nextOffset null when matched count is an exact multiple of page size', () => {
  const listings = Array.from({ length: 30 }, (_, i) => makeListing({ id: String(i), discount_percent: i }))
  const page = paginateListings(listings, DEFAULT_FILTERS, 0)
  expect(page.listings).toHaveLength(30)
  expect(page.nextOffset).toBeNull()
})

test('paginateListings matchedCount reflects the post-filter total, not the page size', () => {
  const listings = [
    ...Array.from({ length: 35 }, (_, i) => makeListing({ id: `open-${i}`, discount_percent: i })),
    makeListing({ id: 'sold', sold_at: '2026-01-01T00:00:00Z' }),
  ]
  const page = paginateListings(listings, DEFAULT_FILTERS, 0) // hideSold defaults true
  expect(page.matchedCount).toBe(35)
  expect(page.listings).toHaveLength(30)
})

test('paginateListings flags reposts on both pages of a repost pair split across the page boundary', () => {
  // 'repost-low' sorts to the very end (discount 0, lowest) and 'repost-a'
  // to the very front (discount 34, highest) via discount_desc, so with a
  // 30-item page size the pair lands on two different pages, but the
  // repost check must have run over the FULL set before slicing.
  const listings = [
    makeListing({ id: 'repost-a', title: 'Same Title', discount_percent: 34 }),
    ...Array.from({ length: 33 }, (_, i) => makeListing({ id: `filler-${i}`, discount_percent: 33 - i })),
    makeListing({ id: 'repost-low', title: 'Same Title', discount_percent: 0 }),
  ]
  const page1 = paginateListings(listings, DEFAULT_FILTERS, 0)
  const page2 = paginateListings(listings, DEFAULT_FILTERS, 30)
  expect(page1.listings.find((l) => l.id === 'repost-a')?.is_repost).toBe(true)
  expect(page2.listings.find((l) => l.id === 'repost-low')?.is_repost).toBe(true)
})

test('paginateListings allIds covers the full filtered/sorted set regardless of offset', () => {
  const listings = [
    ...Array.from({ length: 35 }, (_, i) => makeListing({ id: `open-${i}`, discount_percent: i })),
    makeListing({ id: 'sold', sold_at: '2026-01-01T00:00:00Z' }), // excluded by default hideSold
  ]
  const page1 = paginateListings(listings, DEFAULT_FILTERS, 0)
  const page2 = paginateListings(listings, DEFAULT_FILTERS, 30)
  expect(page1.allIds).toHaveLength(35)
  expect(page1.allIds).not.toContain('sold')
  expect(page2.allIds).toEqual(page1.allIds)
})
