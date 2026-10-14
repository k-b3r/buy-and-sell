import { expect, test } from 'vitest'
import { getProductSummaries } from './product-list'
import type { QueryClient } from '../../platform/storage'

function fakeDb(rows: Record<string, unknown>[]): QueryClient {
  return { query: async () => ({ rows }) }
}

test('getProductSummaries maps rows into ProductSummary shape with numeric fields coerced', async () => {
  const db = fakeDb([
    {
      id: 1,
      base_model: 'RTX 3060',
      variant_tier: null,
      category: 'PC Components',
      listing_count: '8',
      price_min: '12000',
      price_max: '18500',
      price_avg: '15250.5',
      sample_photo_url: 'https://x/0.jpg',
      new_price_low: null,
      new_price_high: null,
      used_price_low: '15000',
      used_price_high: '20000',
      used_price_source: 'web_search',
      has_trained_price_knowledge: null,
      trained_price_low: null,
      trained_price_high: null,
      best_discount_percent: null,
      discounted_listing_count: '0',
    },
    {
      id: 2,
      base_model: 'iPhone 13',
      variant_tier: '128GB',
      category: null,
      listing_count: '3',
      price_min: null,
      price_max: null,
      price_avg: null,
      sample_photo_url: null,
      new_price_low: null,
      new_price_high: null,
      used_price_low: null,
      used_price_high: null,
      used_price_source: null,
      has_trained_price_knowledge: null,
      trained_price_low: null,
      trained_price_high: null,
      best_discount_percent: null,
      discounted_listing_count: '0',
    },
  ])

  const result = await getProductSummaries(db)

  expect(result).toEqual([
    {
      id: 1,
      base_model: 'RTX 3060',
      variant_tier: null,
      category: 'PC Components',
      listing_count: 8,
      price_min: 12000,
      price_max: 18500,
      price_avg: 15250.5,
      sample_photo_url: 'https://x/0.jpg',
      new_price_low: null,
      new_price_high: null,
      secondhand_price_low: 15000,
      secondhand_price_high: 20000,
      secondhand_price_source: 'web_search',
      best_discount_percent: null,
      discounted_listing_count: 0,
      discount_bands: [],
      pricing_excluded_reason: null,
    },
    {
      id: 2,
      base_model: 'iPhone 13',
      variant_tier: '128GB',
      category: null,
      listing_count: 3,
      price_min: null,
      price_max: null,
      price_avg: null,
      sample_photo_url: null,
      new_price_low: null,
      new_price_high: null,
      secondhand_price_low: null,
      secondhand_price_high: null,
      secondhand_price_source: null,
      best_discount_percent: null,
      discounted_listing_count: 0,
      discount_bands: [],
      pricing_excluded_reason: null,
    },
  ])
})

test('getProductSummaries surfaces best_discount_percent and discounted_listing_count when present', async () => {
  const db = fakeDb([
    {
      id: 42,
      base_model: 'RTX 3060',
      variant_tier: null,
      listing_count: '4',
      price_min: '12000',
      price_max: '18000',
      price_avg: '15000',
      sample_photo_url: null,
      new_price_low: null,
      new_price_high: null,
      used_price_low: null,
      used_price_high: null,
      used_price_source: null,
      has_trained_price_knowledge: null,
      trained_price_low: null,
      trained_price_high: null,
      best_discount_percent: '20',
      discounted_listing_count: '2',
    },
  ])

  const result = await getProductSummaries(db)

  expect(result[0].best_discount_percent).toBe(20)
  expect(result[0].discounted_listing_count).toBe(2)
})

test('getProductSummaries surfaces a brand-new price from Exa independently of secondhand', async () => {
  const db = fakeDb([
    {
      id: 310,
      base_model: 'iPhone 15',
      variant_tier: 'Plus',
      listing_count: '4',
      price_min: '25000',
      price_max: '32500',
      price_avg: '28999',
      sample_photo_url: null,
      new_price_low: '68990',
      new_price_high: '89990',
      used_price_low: null,
      used_price_high: null,
      used_price_source: null,
      has_trained_price_knowledge: true,
      trained_price_low: '35000',
      trained_price_high: '40000',
    },
  ])

  const result = await getProductSummaries(db)

  expect(result[0].new_price_low).toBe(68990)
  expect(result[0].new_price_high).toBe(89990)
  // No gemini_grounding/web_search/listing_prices row - falls back to Groq's trained secondhand knowledge
  expect(result[0].secondhand_price_low).toBe(35000)
  expect(result[0].secondhand_price_high).toBe(40000)
  expect(result[0].secondhand_price_source).toBe('groq_trained')
})

test('getProductSummaries does not fall back to Groq trained knowledge when has_trained_price_knowledge is false', async () => {
  const db = fakeDb([
    {
      id: 5,
      base_model: 'Obscure Widget',
      variant_tier: null,
      listing_count: '1',
      price_min: '500',
      price_max: '500',
      price_avg: '500',
      sample_photo_url: null,
      new_price_low: null,
      new_price_high: null,
      used_price_low: null,
      used_price_high: null,
      used_price_source: null,
      has_trained_price_knowledge: false,
      trained_price_low: null,
      trained_price_high: null,
    },
  ])

  const result = await getProductSummaries(db)

  expect(result[0].secondhand_price_low).toBeNull()
  expect(result[0].secondhand_price_source).toBeNull()
})

test('getProductSummaries maps sub_category onto the returned rows', async () => {
  const db: QueryClient = {
    query: async () => ({
      rows: [
        {
          id: 1,
          base_model: 'Sony WH-1000XM5',
          variant_tier: null,
          category: 'Audio',
          sub_category: 'Headphones & Earphones',
          listing_count: '3',
          price_min: null,
          price_max: null,
          price_avg: null,
          sample_photo_url: null,
          new_price_low: null,
          new_price_high: null,
          used_price_low: null,
          used_price_high: null,
          used_price_source: null,
          has_trained_price_knowledge: null,
          trained_price_low: null,
          trained_price_high: null,
          best_discount_percent: null,
          discounted_listing_count: '0',
          discount_bands: null,
        },
      ],
    }),
  }

  const result = await getProductSummaries(db)

  expect(result[0].sub_category).toBe('Headphones & Earphones')
})
