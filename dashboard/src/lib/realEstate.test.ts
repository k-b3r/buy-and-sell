import { expect, test } from 'vitest'
import {
  parseRealEstateFilters,
  formatPrice,
  formatAreaLine,
  formatReviewReason,
  realEstatePageQuery,
  NCR_AREAS,
} from './realEstate'
import type { RealEstateListing } from './shared.generated'

const listing = (over: Partial<RealEstateListing> = {}): RealEstateListing => ({
  id: '1',
  title: 'Condo',
  primary_photo_url: null,
  listed_at: null,
  first_seen_at: '2026-09-01T00:00:00.000Z',
  listed_price: 13,
  listing_type: 'sale',
  property_type: 'condo',
  price_php: 13000000,
  price_basis: 'total',
  lot_sqm: null,
  floor_sqm: 35,
  bedrooms: 1,
  bathrooms: 1,
  project_name: 'Portico',
  area_text: 'Pasig',
  tags: [],
  confidence: 'high',
  price_per_sqm: 371428,
  needs_review: false,
  ...over,
})

test('NCR_AREAS lists the 17 Metro Manila LGUs', () => {
  expect(NCR_AREAS).toHaveLength(17)
})

test('parseRealEstateFilters reads only valid values and computes the page offset', () => {
  const { filters, page } = parseRealEstateFilters({
    kind: 'rent',
    type: 'condo',
    area: 'Makati',
    min: '1000',
    max: '50000',
    sqm: '30',
    sort: 'price_asc',
    page: '3',
  })
  expect(filters).toMatchObject({
    listingType: 'rent',
    propertyType: 'condo',
    area: 'Makati',
    minPrice: 1000,
    maxPrice: 50000,
    minSqm: 30,
    sort: 'price_asc',
    limit: 30,
    offset: 60,
  })
  expect(page).toBe(3)
})

test('parseRealEstateFilters ignores garbage and defaults to page 1', () => {
  const { filters, page } = parseRealEstateFilters({ kind: 'lease', type: 'castle', min: 'abc', sort: 'x', page: '-4' })
  expect(filters.listingType).toBeUndefined()
  expect(filters.propertyType).toBeUndefined()
  expect(filters.minPrice).toBeUndefined()
  expect(filters.sort).toBeUndefined()
  expect(page).toBe(1)
  expect(filters.offset).toBe(0)
})

test('parseRealEstateFilters reads the review tab and the room-share toggle, ignoring other values', () => {
  expect(parseRealEstateFilters({ view: 'review' }).filters.view).toBe('review')
  expect(parseRealEstateFilters({ view: 'nonsense' }).filters.view).toBeUndefined()
  expect(parseRealEstateFilters({ rooms: '1' }).filters.includeRoomShares).toBe(true)
  expect(parseRealEstateFilters({}).filters.includeRoomShares).toBeUndefined()
})

test('formatPrice shows each price basis in its own terms', () => {
  expect(formatPrice(listing())).toBe('₱13,000,000')
  expect(formatPrice(listing({ listing_type: 'rent', price_basis: 'monthly', price_php: 25000 }))).toBe(
    '₱25,000 / month',
  )
  expect(formatPrice(listing({ price_basis: 'per_sqm', price_php: 90000 }))).toBe('₱90,000 / sqm')
  expect(formatPrice(listing({ price_basis: 'equity', price_php: 500000 }))).toBe('₱500,000 equity')
})

test('formatPrice shows the raw listed price when the price is unresolved', () => {
  expect(formatPrice(listing({ price_basis: 'unresolved', price_php: null, listed_price: 13 }))).toBe(
    'Price unclear (listed as ₱13)',
  )
  expect(formatPrice(listing({ price_basis: 'unresolved', price_php: null, listed_price: null }))).toBe(
    'Price not stated',
  )
})

test('formatAreaLine joins only the facts that exist', () => {
  expect(formatAreaLine(listing())).toBe('35 sqm floor · 1 BR · 1 BA')
  expect(formatAreaLine(listing({ lot_sqm: 120, floor_sqm: 60, bedrooms: null, bathrooms: null }))).toBe(
    '120 sqm lot · 60 sqm floor',
  )
  expect(formatAreaLine(listing({ floor_sqm: null, bedrooms: 0, bathrooms: null }))).toBe('Studio')
  expect(formatAreaLine(listing({ floor_sqm: null, bedrooms: null, bathrooms: null }))).toBe('')
})

test('formatReviewReason lists why a listing needs review, and is empty for a clear one', () => {
  expect(
    formatReviewReason(listing({ price_basis: 'unresolved', price_php: null, listing_type: null, confidence: 'low' })),
  ).toBe('price not stated, sale or rent unclear, low confidence')
  expect(formatReviewReason(listing())).toBe('')
})

test('realEstatePageQuery keeps the active filters, drops empty ones and sets the page', () => {
  expect(realEstatePageQuery({ kind: 'rent', area: 'Makati', min: '', page: '1' }, 3)).toBe(
    'kind=rent&area=Makati&page=3',
  )
  expect(realEstatePageQuery({ view: 'review' }, 2)).toBe('view=review&page=2')
})
