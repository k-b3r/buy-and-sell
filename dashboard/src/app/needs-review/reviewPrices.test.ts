import { expect, test } from 'vitest'
import { buildManualPriceRequests, formatTrainedPrice, initialPriceFields, type PriceFields } from './reviewPrices'
import type { ProductNeedingReview, ProductReviewEnrichment } from '../../lib/queries'

const EMPTY: PriceFields = { retailMin: '', retailMax: '', secondhandMin: '', secondhandMax: '' }

function makeProduct(overrides: Partial<ProductNeedingReview> = {}): ProductNeedingReview {
  return {
    id: 1,
    base_model: 'iPhone 13',
    variant_tier: null,
    category: null,
    sub_category: null,
    sample_photo_url: null,
    new_price_low: null,
    new_price_high: null,
    secondhand_price_low: null,
    secondhand_price_high: null,
    price_history: [],
    enrichment: null,
    ...overrides,
  }
}

function makeEnrichment(overrides: Partial<ProductReviewEnrichment> = {}): ProductReviewEnrichment {
  return {
    description: '',
    value_drivers: '',
    has_trained_price_knowledge: true,
    trained_price_low: 100,
    trained_price_high: 200,
    trained_price_currency: 'USD',
    model: 'm',
    checked_at: '2026-01-01',
    confidence: null,
    is_specific_product: null,
    ...overrides,
  }
}

test('initialPriceFields prefills from the product prices and leaves missing ones blank', () => {
  expect(initialPriceFields(makeProduct({ new_price_low: 1000, new_price_high: 2000 }))).toEqual({
    retailMin: '1000',
    retailMax: '2000',
    secondhandMin: '',
    secondhandMax: '',
  })
})

test('buildManualPriceRequests sends only kinds with both min and max filled in', () => {
  expect(buildManualPriceRequests({ ...EMPTY, retailMin: '1000', retailMax: '2000', secondhandMin: '500' })).toEqual({
    requests: [{ kind: 'new', priceLow: 1000, priceHigh: 2000 }],
  })
})

test('buildManualPriceRequests sends both kinds in retail-then-secondhand order', () => {
  expect(
    buildManualPriceRequests({ retailMin: '1000', retailMax: '2000', secondhandMin: '500', secondhandMax: '800' }),
  ).toEqual({
    requests: [
      { kind: 'new', priceLow: 1000, priceHigh: 2000 },
      { kind: 'secondhand', priceLow: 500, priceHigh: 800 },
    ],
  })
})

test('buildManualPriceRequests rejects when no kind has both min and max', () => {
  expect(buildManualPriceRequests({ ...EMPTY, retailMin: '1000', secondhandMax: '  ' })).toEqual({
    error: 'Enter at least one min and max',
  })
})

test('buildManualPriceRequests rejects a non-positive, non-numeric or inverted range', () => {
  const error = { error: 'Min/max must be positive numbers with min ≤ max' }
  expect(buildManualPriceRequests({ ...EMPTY, retailMin: '0', retailMax: '10' })).toEqual(error)
  expect(buildManualPriceRequests({ ...EMPTY, retailMin: 'abc', retailMax: '10' })).toEqual(error)
  expect(buildManualPriceRequests({ ...EMPTY, retailMin: '20', retailMax: '10' })).toEqual(error)
})

test('formatTrainedPrice is null without enrichment or trained price knowledge', () => {
  expect(formatTrainedPrice(makeProduct())).toBeNull()
  expect(
    formatTrainedPrice(makeProduct({ enrichment: makeEnrichment({ has_trained_price_knowledge: false }) })),
  ).toBeNull()
})

test('formatTrainedPrice is null when either bound is missing', () => {
  expect(formatTrainedPrice(makeProduct({ enrichment: makeEnrichment({ trained_price_high: null }) }))).toBeNull()
})

test('formatTrainedPrice shows the currency and range, trimmed when the currency is missing', () => {
  expect(formatTrainedPrice(makeProduct({ enrichment: makeEnrichment() }))).toBe('USD 100-200')
  expect(formatTrainedPrice(makeProduct({ enrichment: makeEnrichment({ trained_price_currency: null }) }))).toBe(
    '100-200',
  )
})
