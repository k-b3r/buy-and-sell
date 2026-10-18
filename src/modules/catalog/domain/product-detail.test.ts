import { expect, test } from 'vitest'
import { assembleProductDetail } from './product-detail'
import type { ProductDetailSource } from './product-detail'

const product: ProductDetailSource['product'] = {
  id: 1,
  base_model: 'RTX 3060',
  variant_tier: null,
  price_lookup_excluded: false,
  pricing_excluded_reason: null,
  new_price_low: null,
  new_price_high: null,
  used_price_low: null,
  used_price_high: null,
  used_price_source: null,
  has_trained_price_knowledge: null,
  trained_price_low: null,
  trained_price_high: null,
  enrichment: null,
}

function listing(id: string, price: number | null, overrides: Partial<ProductDetailSource['listings'][number]> = {}) {
  return {
    id,
    title: `RTX 3060 ${id}`,
    price_amount: price,
    primary_photo_url: null,
    condition: null,
    sold_at: null,
    listed_at: null,
    price_review: null,
    is_saved: false,
    verification_reasoning: null,
    is_peer: true,
    ...overrides,
  }
}

test('assembleProductDetail scores each listing against the peer median and drops the helper field', () => {
  const detail = assembleProductDetail({
    product,
    listings: [listing('a', 10000), listing('b', 10000), listing('c', 10000), listing('d', 10000), listing('e', 5000)],
  })

  const cheap = detail.listings.find((l) => l.id === 'e')
  expect(cheap?.discount_percent).toBe(50)
  expect(cheap?.reference_price).toBe(10000)
  expect(detail.best_discount_percent).toBe(50)
  expect(detail.discounted_listing_count).toBe(1)
  expect(detail.listings[0]).not.toHaveProperty('is_peer')
})

test('assembleProductDetail computes no discounts for a price_lookup_excluded product', () => {
  const detail = assembleProductDetail({
    product: { ...product, price_lookup_excluded: true, pricing_excluded_reason: 'too_generic' },
    listings: [listing('a', 10000), listing('b', 10000), listing('c', 10000), listing('d', 10000), listing('e', 5000)],
  })

  expect(detail.listings.every((l) => l.discount_percent === null)).toBe(true)
  expect(detail.discounted_listing_count).toBe(0)
  expect(detail.pricing_excluded_reason).toBe('too_generic')
})

test('assembleProductDetail flags reposts and falls back to the trained price when no used price exists', () => {
  const detail = assembleProductDetail({
    product: { ...product, has_trained_price_knowledge: true, trained_price_low: '9000', trained_price_high: '12000' },
    listings: [listing('a', 9000, { title: 'Same Title' }), listing('b', 9500, { title: ' same title ' })],
  })

  expect(detail.listings.map((l) => l.is_repost)).toEqual([true, true])
  expect(detail.secondhand_price_low).toBe(9000)
  expect(detail.secondhand_price_source).toBe('groq_trained')
})
