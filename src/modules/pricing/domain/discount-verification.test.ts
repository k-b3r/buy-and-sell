import { buildPriceQuery } from '../prompts/discount-verification.prompt'
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

test('buildPriceQuery asks for a secondhand price for a "Used - like new" condition, not retail', () => {
  // Regression: "Used - like new" contains "new" but is never actually
  // new-in-box - used to get misread as a New condition and priced against
  // brand-new retail instead of the secondhand market.
  const query = buildPriceQuery(candidate({ condition: 'Used - like new' }))

  expect(query).toContain('current secondhand/resale price')
  expect(query).not.toContain('current retail price')
})

test('buildPriceQuery asks for a secondhand price for ordinary used conditions', () => {
  expect(buildPriceQuery(candidate({ condition: 'Used - Good' }))).toContain('current secondhand/resale price')
  expect(buildPriceQuery(candidate({ condition: 'Used - Fair' }))).toContain('current secondhand/resale price')
})

test('buildPriceQuery asks for a retail price only for a genuinely new (not "used") condition', () => {
  expect(buildPriceQuery(candidate({ condition: 'New' }))).toContain('current retail price')
  expect(buildPriceQuery(candidate({ condition: 'Brand New' }))).toContain('current retail price')
})

test('buildPriceQuery treats a null condition as secondhand (safer default, not retail)', () => {
  expect(buildPriceQuery(candidate({ condition: null }))).toContain('current secondhand/resale price')
})

test('buildPriceQuery appends title/description as a spec hint when base_model is too generic to price alone', () => {
  // Regression: bare "HP Laptop"/"Desktop" pulled pricing for far stronger
  // configs than the actual budget unit - title/description usually still
  // carry the real spec (CPU/RAM/storage) that extraction stripped out of
  // base_model.
  const query = buildPriceQuery(
    candidate({
      base_model: 'HP Laptop',
      title: 'Rush sale HP laptop Intel Celeron 8gb ram 128gb SSD',
      description: 'good keyboard LCD camera, speaker needs drivers',
    }),
  )

  expect(query).toContain('HP Laptop')
  expect(query).toContain('Intel Celeron 8gb ram 128gb SSD')
  expect(query).toContain('speaker needs drivers')
})

test('buildPriceQuery falls back to bare base_model when title and description are both null', () => {
  const query = buildPriceQuery(candidate({ base_model: 'HP Laptop', title: null, description: null }))

  expect(query).toBe('current secondhand/resale price of HP Laptop in the Philippines')
})

test('buildPriceQuery truncates an overly long spec hint rather than sending an unbounded query', () => {
  const longDescription = 'x'.repeat(500)
  const query = buildPriceQuery(candidate({ title: null, description: longDescription }))

  expect(query.length).toBeLessThan(300)
})

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
