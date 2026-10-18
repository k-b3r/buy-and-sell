import { LISTINGS_PAGE_SIZE, paginateListings } from './listings-page'
import type { ListingsFilters } from '../schemas'
import type { ProductDetail } from '../product-detail'

type Listing = ProductDetail['listings'][number]

const NOW = Date.parse('2026-10-18T00:00:00.000Z')

const DEFAULT_FILTERS: ListingsFilters = {
  sortKey: 'discount_desc',
  listedWithinDays: 0,
  hideSold: true,
  negotiableOnly: false,
  selectedBand: null,
}

function makeListing(overrides: Partial<Listing> & { id: string }): Listing {
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
    is_repost: false,
    verification_reasoning: null,
    ...overrides,
  }
}

function many(count: number, overrides: (i: number) => Partial<Listing> = (i) => ({ discount_percent: i })) {
  return Array.from({ length: count }, (_, i) => makeListing({ id: String(i), ...overrides(i) }))
}

test('paginateListings returns the first page sorted by discount desc by default', () => {
  const listings = [
    makeListing({ id: 'a', discount_percent: 10 }),
    makeListing({ id: 'b', discount_percent: 30 }),
    makeListing({ id: 'c', discount_percent: 20 }),
  ]

  const page = paginateListings(listings, DEFAULT_FILTERS, 0, NOW)

  expect(page.listings.map((l) => l.id)).toEqual(['b', 'c', 'a'])
})

test('paginateListings slices to LISTINGS_PAGE_SIZE and sets nextOffset when more remain', () => {
  const page = paginateListings(many(35), DEFAULT_FILTERS, 0, NOW)

  expect(page.listings).toHaveLength(LISTINGS_PAGE_SIZE)
  expect(page.nextOffset).toBe(LISTINGS_PAGE_SIZE)
})

test('paginateListings returns nextOffset null exactly when the last page is reached', () => {
  const page = paginateListings(many(35), DEFAULT_FILTERS, 30, NOW)

  expect(page.listings).toHaveLength(5)
  expect(page.nextOffset).toBeNull()
})

test('paginateListings returns nextOffset null when the matched count is an exact multiple of the page size', () => {
  const page = paginateListings(many(30), DEFAULT_FILTERS, 0, NOW)

  expect(page.listings).toHaveLength(30)
  expect(page.nextOffset).toBeNull()
})

test('paginateListings matchedCount reflects the post-filter total and allIds spans every page', () => {
  const listings = [...many(35), makeListing({ id: 'sold', sold_at: '2026-01-01T00:00:00Z' })]

  const page1 = paginateListings(listings, DEFAULT_FILTERS, 0, NOW)
  const page2 = paginateListings(listings, DEFAULT_FILTERS, 30, NOW)

  expect(page1.matchedCount).toBe(35)
  expect(page1.allIds).toHaveLength(35)
  expect(page1.allIds).not.toContain('sold')
  expect(page2.allIds).toEqual(page1.allIds)
})

test('paginateListings keeps sold listings when hideSold is off', () => {
  const listings = [makeListing({ id: 'open' }), makeListing({ id: 'sold', sold_at: '2026-01-01T00:00:00Z' })]

  const page = paginateListings(listings, { ...DEFAULT_FILTERS, hideSold: false }, 0, NOW)

  expect(page.matchedCount).toBe(2)
})

test('paginateListings keeps only listings inside the selected discount decade', () => {
  const listings = [
    makeListing({ id: 'in-low', discount_percent: 20 }),
    makeListing({ id: 'in-high', discount_percent: 29 }),
    makeListing({ id: 'out', discount_percent: 30 }),
    makeListing({ id: 'none', discount_percent: null }),
  ]

  const page = paginateListings(listings, { ...DEFAULT_FILTERS, selectedBand: 20 }, 0, NOW)

  expect(page.allIds.sort()).toEqual(['in-high', 'in-low'])
})

test('paginateListings negotiableOnly keeps price-reviewed, placeholder and undiscounted listings', () => {
  const listings = [
    makeListing({ id: 'discounted', price_amount: 5000, discount_percent: 25 }),
    makeListing({ id: 'no-discount', price_amount: 5000, discount_percent: null }),
    makeListing({ id: 'zero-discount', price_amount: 5000, discount_percent: 0 }),
  ]

  const page = paginateListings(listings, { ...DEFAULT_FILTERS, negotiableOnly: true }, 0, NOW)

  expect(page.allIds.sort()).toEqual(['no-discount', 'zero-discount'])
})

test('paginateListings listedWithinDays drops older and undated listings', () => {
  const now = NOW
  const day = 24 * 60 * 60 * 1000
  const listings = [
    makeListing({ id: 'fresh', listed_at: new Date(now - 2 * day).toISOString() }),
    makeListing({ id: 'old', listed_at: new Date(now - 20 * day).toISOString() }),
    makeListing({ id: 'undated', listed_at: null }),
  ]

  const page = paginateListings(listings, { ...DEFAULT_FILTERS, listedWithinDays: 7 }, 0, NOW)

  expect(page.allIds).toEqual(['fresh'])
})

test('paginateListings sorts nulls last in both directions', () => {
  const listings = [
    makeListing({ id: 'none', price_amount: null }),
    makeListing({ id: 'cheap', price_amount: 10 }),
    makeListing({ id: 'dear', price_amount: 90 }),
  ]

  const asc = paginateListings(listings, { ...DEFAULT_FILTERS, sortKey: 'price_asc' }, 0, NOW)
  const desc = paginateListings(listings, { ...DEFAULT_FILTERS, sortKey: 'price_desc' }, 0, NOW)

  expect(asc.allIds).toEqual(['cheap', 'dear', 'none'])
  expect(desc.allIds).toEqual(['dear', 'cheap', 'none'])
})

test('paginateListings sorts by listed date newest and oldest first', () => {
  const listings = [
    makeListing({ id: 'mid', listed_at: '2026-02-01T00:00:00Z' }),
    makeListing({ id: 'new', listed_at: '2026-03-01T00:00:00Z' }),
    makeListing({ id: 'old', listed_at: '2026-01-01T00:00:00Z' }),
  ]

  const newest = paginateListings(
    listings,
    { ...DEFAULT_FILTERS, sortKey: 'listed_newest', listedWithinDays: 0 },
    0,
    NOW,
  )
  const oldest = paginateListings(listings, { ...DEFAULT_FILTERS, sortKey: 'listed_oldest' }, 0, NOW)

  expect(newest.allIds).toEqual(['new', 'mid', 'old'])
  expect(oldest.allIds).toEqual(['old', 'mid', 'new'])
})
