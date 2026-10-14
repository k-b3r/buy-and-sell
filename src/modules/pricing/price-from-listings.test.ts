import { computePriceRangeFromPrices } from './price-from-listings'

test('computePriceRangeFromPrices drops junk prices under the floor before taking min/max', () => {
  const result = computePriceRangeFromPrices([12, 20, 14999, 15000, 15000])
  expect(result).toEqual({ low: 14999, high: 15000, currency: 'PHP', usedCount: 3 })
})

test('computePriceRangeFromPrices drops placeholder-pattern prices like the shared junk rule', () => {
  const result = computePriceRangeFromPrices([12345, 9999, 14000, 15000, 16000])
  expect(result).toEqual({ low: 14000, high: 16000, currency: 'PHP', usedCount: 3 })
})

test('computePriceRangeFromPrices returns null when fewer than 3 valid prices remain after filtering', () => {
  expect(computePriceRangeFromPrices([12, 15000, 16000])).toBeNull()
  expect(computePriceRangeFromPrices([12, 20])).toBeNull()
  expect(computePriceRangeFromPrices([15000])).toBeNull()
  expect(computePriceRangeFromPrices([])).toBeNull()
})
