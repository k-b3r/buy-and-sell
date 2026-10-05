import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
  summarizeDiscounts,
  isPlaceholderPrice,
  isMagnitudeOutlier,
  isPriceInvalidated,
  computeListingDiscount,
  isListingPriceNegotiable,
} from './pricing'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// The server splits these across price-rules.ts and clean-median.ts.
const SERVER_PRICE_RULES = ['price-rules.ts', 'clean-median.ts'].map((f) =>
  path.join(HERE, '../../../src/modules/pricing', f),
)

// These functions exist in two places on purpose (see pricing.ts's header):
// src/modules/pricing/price-rules.ts computes them alongside the SQL, this
// copy runs in the browser. Nothing at build time links the two, so this test is the only
// thing standing between a one-sided edit and the dashboard quietly showing
// a different price verdict than the server computed. Bodies are compared
// with comments and whitespace stripped - reworded comments are fine,
// changed logic is not.
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`)
  if (start === -1) throw new Error(`${name} not found`)
  const end = source.indexOf('\n}', start)
  if (end === -1) throw new Error(`${name} body not terminated`)
  return source
    .slice(start, end)
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

test.each([
  'summarizeDiscounts',
  'isPlaceholderPrice',
  'isMagnitudeOutlier',
  'isPriceInvalidated',
  'computeListingDiscount',
  'isListingPriceNegotiable',
])('%s stays identical to the server copy', (name) => {
  const serverSource = SERVER_PRICE_RULES.map((f) => readFileSync(f, 'utf8')).join('\n')
  const localSource = readFileSync(path.join(HERE, 'pricing.ts'), 'utf8')

  expect(bodyOf(localSource, name)).toBe(bodyOf(serverSource, name))
})

test('placeholder prices are caught by pattern, not magnitude', () => {
  expect(isPlaceholderPrice(123)).toBe(true)
  expect(isPlaceholderPrice(12456)).toBe(true)
  expect(isPlaceholderPrice(9999)).toBe(true)
  expect(isPlaceholderPrice(6969)).toBe(true)
  expect(isPlaceholderPrice(99)).toBe(false)
  expect(isPlaceholderPrice(15000)).toBe(false)
})

test('magnitude outliers are relative to the raw median', () => {
  expect(isMagnitudeOutlier(200000, 15000)).toBe(true)
  expect(isMagnitudeOutlier(100, 15000)).toBe(true)
  expect(isMagnitudeOutlier(14000, 15000)).toBe(false)
  expect(isMagnitudeOutlier(14000, null)).toBe(false)
})

test('a price can be invalidated by pattern despite a sane magnitude', () => {
  expect(isMagnitudeOutlier(123456, 150000)).toBe(false)
  expect(isPriceInvalidated(123456, 150000)).toBe(true)
})

test('discount needs at least 2 samples and a clean median', () => {
  expect(computeListingDiscount(8000, 10000, 10000, 5)).toEqual({ discountPercent: 20, referencePrice: 10000 })
  expect(computeListingDiscount(8000, 10000, 10000, 1).discountPercent).toBeNull()
  expect(computeListingDiscount(8000, null, null, 5).discountPercent).toBeNull()
  expect(computeListingDiscount(123, 10000, 10000, 5).discountPercent).toBeNull()
})

test('summarize buckets discounts into descending decade bands above 10%', () => {
  expect(summarizeDiscounts([5, 12, 15, 34, null])).toEqual({
    bestDiscountPercent: 34,
    discountedListingCount: 3,
    bands: [
      { bandFloor: 30, count: 1 },
      { bandFloor: 10, count: 2 },
    ],
  })
  expect(summarizeDiscounts([null, 5]).bands).toEqual([])
})

test('negotiable falls back to "no signal to show"', () => {
  expect(isListingPriceNegotiable(5000, { is_negotiable: true, price_low: null, price_high: null }, 40)).toBe(true)
  expect(isListingPriceNegotiable(123, null, 40)).toBe(true)
  expect(isListingPriceNegotiable(5000, null, 0)).toBe(true)
  expect(isListingPriceNegotiable(5000, null, 40)).toBe(false)
})
