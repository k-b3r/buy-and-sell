import { precheckDiscountCandidate } from './discount-verification'
import type { DiscountVerificationCandidate } from '../types'

function candidate(overrides: Partial<DiscountVerificationCandidate> = {}): DiscountVerificationCandidate {
  return {
    id: 7,
    listing_id: '123',
    title: 'Sony WH-1000XM5',
    description: 'Used, minor scuff on headband, battery still great, box included',
    condition: 'Used - Good',
    price_amount: 6500,
    base_model: 'Sony WH-1000XM5',
    is_specific_product: true,
    ...overrides,
  }
}

test('precheckDiscountCandidate: price below the floor rejects, synchronously', () => {
  expect(precheckDiscountCandidate(candidate({ price_amount: 100 }))).toEqual({
    outcome: 'rejected',
    reasoning: 'Asking price below the ₱500 floor - not worth chasing regardless of discount math.',
  })
})

test('precheckDiscountCandidate: non-specific product rejects, synchronously', () => {
  expect(precheckDiscountCandidate(candidate({ is_specific_product: false }))).toEqual({
    outcome: 'rejected',
    reasoning: 'Product is not a specific, priceable item.',
  })
})

test('precheckDiscountCandidate: unenriched product is pending, synchronously', () => {
  expect(precheckDiscountCandidate(candidate({ is_specific_product: null }))).toEqual({
    outcome: 'pending',
    reasoning: 'Product enrichment not yet available.',
  })
})

test('precheckDiscountCandidate: a priced, specific product proceeds', () => {
  expect(precheckDiscountCandidate(candidate())).toEqual({ outcome: 'proceed' })
})
