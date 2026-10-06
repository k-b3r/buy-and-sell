import { expect, test } from 'vitest'
import { formatListingPrice } from './listingPrice'
import type { ListingPriceReview } from './shared.generated'

function priced(price_amount: number | null, price_review: ListingPriceReview | null = null) {
  return { price_amount, price_review }
}

test('formatListingPrice shows the recorded price when there is no price review', () => {
  expect(formatListingPrice(priced(15000))).toBe(`₱${(15000).toLocaleString()}`)
})

test('formatListingPrice shows a dash when there is no recorded price and no review', () => {
  expect(formatListingPrice(priced(null))).toBe('—')
})

test('formatListingPrice shows the given empty label when there is no price to show', () => {
  expect(formatListingPrice(priced(null), 'Price not listed')).toBe('Price not listed')
  expect(
    formatListingPrice(priced(15000, { is_negotiable: false, price_low: null, price_high: null }), 'Price not listed'),
  ).toBe(`₱${(15000).toLocaleString()}`)
})

test('formatListingPrice shows a single reviewed price when low and high match', () => {
  expect(formatListingPrice(priced(1, { is_negotiable: false, price_low: 9000, price_high: 9000 }))).toBe(
    `₱${(9000).toLocaleString()}`,
  )
})

test('formatListingPrice shows the reviewed range when low and high differ', () => {
  expect(formatListingPrice(priced(1, { is_negotiable: false, price_low: 9000, price_high: 12000 }))).toBe(
    `₱${(9000).toLocaleString()}–₱${(12000).toLocaleString()}`,
  )
})

test('formatListingPrice falls back to the recorded price when the review has no determinable price', () => {
  expect(formatListingPrice(priced(15000, { is_negotiable: true, price_low: null, price_high: null }))).toBe(
    `₱${(15000).toLocaleString()}`,
  )
})

test('formatListingPrice falls back to the recorded price when the review has only one bound', () => {
  expect(formatListingPrice(priced(15000, { is_negotiable: false, price_low: 9000, price_high: null }))).toBe(
    `₱${(15000).toLocaleString()}`,
  )
})
