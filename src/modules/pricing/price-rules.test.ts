import { expect, test } from 'vitest'
import {
  DISCOUNT_SUMMARY_LATERAL,
  computeListingDiscount,
  isListingPriceNegotiable,
  isNewCondition,
  isPriceInvalidated,
  resolveSecondhandPrice,
  summarizeDiscounts,
} from './price-rules'
import { peerListingSql } from './clean-median'

test('summarizeDiscounts groups qualifying discounts into descending decade bands', () => {
  const result = summarizeDiscounts([73, 68, 41, 22, 5, null, -10])
  expect(result).toEqual({
    bestDiscountPercent: 73,
    discountedListingCount: 4,
    bands: [
      { bandFloor: 70, count: 1 },
      { bandFloor: 60, count: 1 },
      { bandFloor: 40, count: 1 },
      { bandFloor: 20, count: 1 },
    ],
  })
})

test('summarizeDiscounts excludes single-digit discounts (floor at 10%)', () => {
  expect(summarizeDiscounts([9, 5, 1])).toEqual({ bestDiscountPercent: null, discountedListingCount: 0, bands: [] })
})

test('summarizeDiscounts groups multiple listings in the same decade band together', () => {
  expect(summarizeDiscounts([43, 41, 45])).toEqual({
    bestDiscountPercent: 45,
    discountedListingCount: 3,
    bands: [{ bandFloor: 40, count: 3 }],
  })
})

test('summarizeDiscounts returns an empty summary for no qualifying discounts', () => {
  expect(summarizeDiscounts([])).toEqual({ bestDiscountPercent: null, discountedListingCount: 0, bands: [] })
  expect(summarizeDiscounts([null, null])).toEqual({ bestDiscountPercent: null, discountedListingCount: 0, bands: [] })
})

test('isListingPriceNegotiable is true when the LLM review says so, even with a real discount value present', () => {
  expect(isListingPriceNegotiable(17499, { is_negotiable: true, price_low: null, price_high: null }, 20)).toBe(true)
})

test('isListingPriceNegotiable is true for a placeholder-pattern price, even with a real discount value present', () => {
  expect(isListingPriceNegotiable(12456, null, 20)).toBe(true)
})

test('isListingPriceNegotiable is true for a placeholder-pattern price even when the review row says not negotiable', () => {
  expect(isListingPriceNegotiable(123456, { is_negotiable: false, price_low: null, price_high: null }, 20)).toBe(true)
})

test('isListingPriceNegotiable is true when there is no discount/overvalue signal to show (discount_percent null)', () => {
  expect(isListingPriceNegotiable(17499, null, null)).toBe(true)
})

test('isListingPriceNegotiable is true when discount_percent is exactly 0 - the same condition DiscountBadge treats as "nothing to show"', () => {
  expect(isListingPriceNegotiable(17499, null, 0)).toBe(true)
})

test('isListingPriceNegotiable is false for an ordinary price with a real nonzero discount value and no review row', () => {
  expect(isListingPriceNegotiable(17499, null, 15)).toBe(false)
})

test('isPriceInvalidated is true for either a magnitude outlier or a placeholder pattern, even in-range', () => {
  expect(isPriceInvalidated(999999999, 15000)).toBe(true) // magnitude outlier
  expect(isPriceInvalidated(12345, 15000)).toBe(true) // placeholder pattern (ascending run), well within 10x range
})

test('isPriceInvalidated is false for an ordinary in-range, non-placeholder price', () => {
  expect(isPriceInvalidated(12000, 15000)).toBe(false)
})

test('computeListingDiscount is null when fewer than 3 same-product listings exist to compare against', () => {
  expect(computeListingDiscount(15000, 15000, 15000, 1)).toEqual({ discountPercent: null, referencePrice: null })
  expect(computeListingDiscount(15000, 15000, 15000, 2)).toEqual({ discountPercent: null, referencePrice: null })
})

test('computeListingDiscount is null when this listing itself is a magnitude outlier (>10x or <0.1x the raw median)', () => {
  // ₱999,999,999 "for swap only" placeholder against a real ₱15,000 median
  expect(computeListingDiscount(999999999, 15000, 15000, 5)).toEqual({ discountPercent: null, referencePrice: null })
  // ₱10 "for attention only" placeholder
  expect(computeListingDiscount(10, 15000, 15000, 5)).toEqual({ discountPercent: null, referencePrice: null })
})

test('computeListingDiscount computes percent below the outlier-excluded median for an in-range listing', () => {
  // priced at 12000 against a clean median of 15000 -> 20% below
  expect(computeListingDiscount(12000, 15000, 15000, 5)).toEqual({ discountPercent: 20, referencePrice: 15000 })
})

test('computeListingDiscount is negative when priced above the reference (not a discount)', () => {
  expect(computeListingDiscount(18000, 15000, 15000, 5)).toEqual({ discountPercent: -20, referencePrice: 15000 })
})

test('computeListingDiscount uses the outlier-excluded median as the reference, not the raw one', () => {
  // raw median pulled up by an outlier at 999999999; clean median (outlier excluded) is the real 15000
  expect(computeListingDiscount(12000, 50000, 15000, 5)).toEqual({ discountPercent: 20, referencePrice: 15000 })
})

test('computeListingDiscount is null when the listing price is a placeholder pattern, even within magnitude range', () => {
  // ₱123,456 against a ₱150,000 median is well within the 10x magnitude
  // threshold, but it's a classic "fake price to get attention" pattern -
  // found live 2026-08-23: this exact case produced a nonsensical -626%
  // "discount" against a real ₱17,000 median before this fix.
  expect(computeListingDiscount(123456, 150000, 150000, 5)).toEqual({ discountPercent: null, referencePrice: null })
})

test('computeListingDiscount is null when price/median data is missing or non-positive', () => {
  expect(computeListingDiscount(null, 15000, 15000, 5)).toEqual({ discountPercent: null, referencePrice: null })
  expect(computeListingDiscount(12000, null, 15000, 5)).toEqual({ discountPercent: null, referencePrice: null })
  expect(computeListingDiscount(12000, 15000, null, 5)).toEqual({ discountPercent: null, referencePrice: null })
  expect(computeListingDiscount(12000, 0, 15000, 5)).toEqual({ discountPercent: null, referencePrice: null })
})

test('isNewCondition reads only a plain "New" label as new, never a "Used - like new" one', () => {
  expect(isNewCondition('New')).toBe(true)
  expect(isNewCondition('Used - Like New')).toBe(false)
  expect(isNewCondition('Used - Good')).toBe(false)
  expect(isNewCondition(null)).toBe(false)
})

test('resolveSecondhandPrice prefers a searched secondhand price over the trained-knowledge guess', () => {
  expect(
    resolveSecondhandPrice({ low: '8000', high: '9000', source: 'exa_secondhand' }, { known: true, low: 1, high: 2 }),
  ).toEqual({ low: 8000, high: 9000, source: 'exa_secondhand' })
})

test('resolveSecondhandPrice falls back to the trained guess only when the model claims the knowledge', () => {
  expect(
    resolveSecondhandPrice({ low: null, high: null, source: null }, { known: true, low: '7000', high: '8000' }),
  ).toEqual({
    low: 7000,
    high: 8000,
    source: 'groq_trained',
  })
  expect(
    resolveSecondhandPrice({ low: null, high: null, source: null }, { known: false, low: '7000', high: '8000' }),
  ).toEqual({
    low: null,
    high: null,
    source: null,
  })
})

test('DISCOUNT_SUMMARY_LATERAL takes the product median over peer listings only, never for an excluded product', () => {
  expect(DISCOUNT_SUMMARY_LATERAL).toContain(peerListingSql('pl'))
  expect(DISCOUNT_SUMMARY_LATERAL).toContain('NOT p.price_lookup_excluded')
})
