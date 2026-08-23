import { expect, test } from 'vitest'
import {
  getProductSummaries,
  getProductDetail,
  getListingDetail,
  computeListingDiscount,
  isPlaceholderPrice,
  summarizeDiscounts,
} from '../src/lib/queries'
import type { QueryClient } from '../src/lib/queries'

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

test('isPlaceholderPrice flags ascending-sequential digit runs', () => {
  expect(isPlaceholderPrice(123)).toBe(true)
  expect(isPlaceholderPrice(1234)).toBe(true)
  expect(isPlaceholderPrice(12345)).toBe(true)
  expect(isPlaceholderPrice(123456)).toBe(true)
})

test('isPlaceholderPrice flags repeated-single-digit runs', () => {
  expect(isPlaceholderPrice(111)).toBe(true)
  expect(isPlaceholderPrice(9999)).toBe(true)
  expect(isPlaceholderPrice(55555)).toBe(true)
})

test('isPlaceholderPrice flags repeated multi-digit block runs (e.g. joke/meme numbers)', () => {
  expect(isPlaceholderPrice(6969)).toBe(true)
  expect(isPlaceholderPrice(696969)).toBe(true)
  expect(isPlaceholderPrice(4242)).toBe(true)
  expect(isPlaceholderPrice(123123)).toBe(true)
})

test('isPlaceholderPrice does not flag real round prices', () => {
  expect(isPlaceholderPrice(500)).toBe(false)
  expect(isPlaceholderPrice(1000)).toBe(false)
  expect(isPlaceholderPrice(15000)).toBe(false)
  expect(isPlaceholderPrice(29999)).toBe(false)
})

test('isPlaceholderPrice does not flag ordinary non-pattern prices', () => {
  expect(isPlaceholderPrice(17499)).toBe(false)
  expect(isPlaceholderPrice(32500)).toBe(false)
})

test('computeListingDiscount is null when fewer than 2 same-product listings exist to compare against', () => {
  expect(computeListingDiscount(15000, 15000, 15000, 1)).toEqual({ discountPercent: null, referencePrice: null })
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

function fakeDb(rows: Record<string, unknown>[]): QueryClient {
  return { query: async () => ({ rows }) }
}

test('getProductSummaries maps rows into ProductSummary shape with numeric fields coerced', async () => {
  const db = fakeDb([
    {
      id: 1,
      base_model: 'RTX 3060',
      variant_tier: null,
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
    },
    {
      id: 2,
      base_model: 'iPhone 13',
      variant_tier: '128GB',
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

test('getProductSummaries defaults to limit 30, offset 0, no search filter', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaries(db)

  expect(capturedParams).toEqual([null, 30, 0])
})

test('getProductSummaries excludes price_lookup_excluded products from the discount computation', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await getProductSummaries(db)

  expect(capturedSql).toContain('NOT p.price_lookup_excluded')
})

test('getProductSummaries excludes placeholder-pattern prices from the price range and discount computation', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await getProductSummaries(db)

  const occurrences = capturedSql.split("'^(\\d+)\\1+$'").length - 1
  expect(occurrences).toBe(4) // price_min, price_max, price_avg, and the discount lateral
})

test('getListingDetail excludes placeholder-pattern prices from the sibling median query', async () => {
  const db: QueryClient = {
    query: async (sql: string) => {
      if (sql.includes('WITH product_prices')) {
        expect(sql).toContain("'^(\\d+)\\1+$'")
        return { rows: [{ raw_median_price: null, sample_size: '0', clean_median_price: null }] }
      }
      return {
        rows: [
          {
            id: '123',
            title: 'x',
            price_amount: '12000',
            price_currency: 'PHP',
            description: null,
            condition: null,
            location_city: null,
            listed_at: null,
            last_seen_at: null,
            primary_photo_url: null,
            stored_photo_urls: null,
            product_id: 1,
            base_model: null,
            variant_tier: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
        ],
      }
    },
  }

  await getListingDetail(db, '123')
})

test('getProductSummaries passes search as an ILIKE pattern and respects offset/limit options', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaries(db, { search: 'RTX', offset: 60, limit: 10 })

  expect(capturedSql).toContain('ILIKE')
  expect(capturedParams).toEqual(['%RTX%', 10, 60])
})

test('getProductSummaries treats an empty/whitespace search as no filter', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaries(db, { search: '   ' })

  expect(capturedParams).toEqual([null, 30, 0])
})

test('getProductDetail returns null when the product does not exist', async () => {
  const db = fakeDb([])
  const result = await getProductDetail(db, 999)
  expect(result).toBeNull()
})

test('getProductDetail returns the product, its new/secondhand prices, and its listings', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 1,
              base_model: 'RTX 3060',
              variant_tier: null,
              new_price_low: null,
              new_price_high: null,
              used_price_low: '15000',
              used_price_high: '20000',
              used_price_source: 'web_search',
              enrichment_description: null,
              enrichment_value_drivers: null,
              enrichment_has_trained_price_knowledge: null,
              enrichment_trained_price_low: null,
              enrichment_trained_price_high: null,
              enrichment_trained_price_currency: null,
              enrichment_model: null,
              enrichment_checked_at: null,
            },
          ],
        }
      }
      return {
        rows: [
          {
            id: '123',
            title: 'RTX 3060 OC Asus',
            price_amount: '15000',
            primary_photo_url: 'https://x/0.jpg',
            condition: 'Used - Like New',
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
        ],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result).toEqual({
    id: 1,
    base_model: 'RTX 3060',
    variant_tier: null,
    new_price_low: null,
    new_price_high: null,
    secondhand_price_low: 15000,
    secondhand_price_high: 20000,
    secondhand_price_source: 'web_search',
    best_discount_percent: null,
    discounted_listing_count: 0,
    discount_bands: [],
    enrichment: null,
    listings: [
      {
        id: '123',
        title: 'RTX 3060 OC Asus',
        price_amount: 15000,
        primary_photo_url: 'https://x/0.jpg',
        condition: 'Used - Like New',
        sold_at: null,
        price_review: null,
        discount_percent: null,
        reference_price: null,
      },
    ],
  })
})

test('getProductDetail computes each listing\'s discount against the outlier-excluded median of its siblings', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 1,
              base_model: 'RTX 3060',
              variant_tier: null,
              new_price_low: null,
              new_price_high: null,
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
              enrichment_description: null,
              enrichment_value_drivers: null,
              enrichment_has_trained_price_knowledge: null,
              enrichment_trained_price_low: null,
              enrichment_trained_price_high: null,
              enrichment_trained_price_currency: null,
              enrichment_model: null,
              enrichment_checked_at: null,
            },
          ],
        }
      }
      // Median of [12000, 15000, 18000, 999999999] before outlier exclusion is
      // pulled way up by the placeholder; the real market median is 15000.
      return {
        rows: [
          { id: 'a', title: 'A', price_amount: '12000', primary_photo_url: null, condition: null, sold_at: null, price_review_is_negotiable: null, price_review_low: null, price_review_high: null },
          { id: 'b', title: 'B', price_amount: '15000', primary_photo_url: null, condition: null, sold_at: null, price_review_is_negotiable: null, price_review_low: null, price_review_high: null },
          { id: 'c', title: 'C', price_amount: '18000', primary_photo_url: null, condition: null, sold_at: null, price_review_is_negotiable: null, price_review_low: null, price_review_high: null },
          { id: 'd', title: 'D (swap only placeholder)', price_amount: '999999999', primary_photo_url: null, condition: null, sold_at: null, price_review_is_negotiable: null, price_review_low: null, price_review_high: null },
          { id: 'e', title: 'E (fake attention price)', price_amount: '123456', primary_photo_url: null, condition: null, sold_at: null, price_review_is_negotiable: null, price_review_low: null, price_review_high: null },
        ],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.listings.map((l) => [l.id, l.discount_percent, l.reference_price])).toEqual([
    ['a', 20, 15000],
    ['b', 0, 15000],
    ['c', -20, 15000],
    ['d', null, null],
    ['e', null, null],
  ])
})

test('getProductDetail suppresses discount computation entirely for a price_lookup_excluded product', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 429,
              base_model: 'Product',
              variant_tier: null,
              price_lookup_excluded: true,
              new_price_low: null,
              new_price_high: null,
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
              enrichment_description: null,
              enrichment_value_drivers: null,
              enrichment_has_trained_price_knowledge: null,
              enrichment_trained_price_low: null,
              enrichment_trained_price_high: null,
              enrichment_trained_price_currency: null,
              enrichment_model: null,
              enrichment_checked_at: null,
            },
          ],
        }
      }
      // Real listings that would otherwise produce real (if nonsensical,
      // since these are unrelated real items) discounts against each other.
      return {
        rows: [
          { id: 'a', title: 'Sale', price_amount: '1000', primary_photo_url: null, condition: null, sold_at: null, price_review_is_negotiable: null, price_review_low: null, price_review_high: null },
          { id: 'b', title: 'Rush Sale', price_amount: '5000', primary_photo_url: null, condition: null, sold_at: null, price_review_is_negotiable: null, price_review_low: null, price_review_high: null },
        ],
      }
    },
  }

  const result = await getProductDetail(db, 429)

  expect(result?.listings.every((l) => l.discount_percent === null)).toBe(true)
  expect(result?.best_discount_percent).toBeNull()
  expect(result?.discount_bands).toEqual([])
})

test('getProductDetail surfaces a brand-new Exa price separately from a Groq-trained secondhand fallback', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 310,
              base_model: 'iPhone 15',
              variant_tier: 'Plus',
              new_price_low: '68990',
              new_price_high: '89990',
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
              enrichment_description: 'desc',
              enrichment_value_drivers: 'drivers',
              enrichment_has_trained_price_knowledge: true,
              enrichment_trained_price_low: '35000',
              enrichment_trained_price_high: '40000',
              enrichment_trained_price_currency: 'PHP',
              enrichment_model: 'openai/gpt-oss-120b',
              enrichment_checked_at: new Date('2026-08-22T00:00:00.000Z'),
            },
          ],
        }
      }
      return { rows: [] }
    },
  }

  const result = await getProductDetail(db, 310)

  expect(result?.new_price_low).toBe(68990)
  expect(result?.new_price_high).toBe(89990)
  expect(result?.secondhand_price_low).toBe(35000)
  expect(result?.secondhand_price_high).toBe(40000)
  expect(result?.secondhand_price_source).toBe('groq_trained')
})

test('getProductSummaries surfaces a brand-new price from Exa independently of secondhand', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 310,
              base_model: 'iPhone 15',
              variant_tier: 'Plus',
              new_price_low: '68990',
              new_price_high: '89990',
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
              enrichment_description: 'desc',
              enrichment_value_drivers: 'drivers',
              enrichment_has_trained_price_knowledge: true,
              enrichment_trained_price_low: '35000',
              enrichment_trained_price_high: '40000',
              enrichment_trained_price_currency: 'PHP',
              enrichment_model: 'openai/gpt-oss-120b',
              enrichment_checked_at: new Date('2026-08-22T00:00:00.000Z'),
            },
          ],
        }
      }
      return { rows: [] }
    },
  }

  const result = await getProductDetail(db, 310)

  expect(result?.new_price_low).toBe(68990)
  expect(result?.new_price_high).toBe(89990)
  expect(result?.secondhand_price_low).toBe(35000)
  expect(result?.secondhand_price_high).toBe(40000)
  expect(result?.secondhand_price_source).toBe('groq_trained')
})

test('getProductDetail includes price_review on a listing when a listing_price_review row exists', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 1,
              base_model: 'RTX 2060',
              variant_tier: null,
              new_price_low: null,
              new_price_high: null,
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
            },
          ],
        }
      }
      return {
        rows: [
          {
            id: '1000000000000001',
            title: 'RTX 2060 6GB FOR SWAP ONLY',
            price_amount: '999999999',
            primary_photo_url: null,
            condition: 'Used - Good',
            sold_at: null,
            price_review_is_negotiable: true,
            price_review_low: '7500',
            price_review_high: '9000',
          },
        ],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.listings[0].price_review).toEqual({
    is_negotiable: true,
    price_low: 7500,
    price_high: 9000,
  })
})

test('getProductDetail marks a listing sold when its sold_at is set', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 1,
              base_model: 'RTX 3060',
              variant_tier: null,
              new_price_low: null,
              new_price_high: null,
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
            },
          ],
        }
      }
      return {
        rows: [
          {
            id: '123',
            title: 'RTX 3060 OC Asus',
            price_amount: '15000',
            primary_photo_url: 'https://x/0.jpg',
            condition: 'Used - Like New',
            sold_at: new Date('2026-08-22T00:00:00.000Z'),
          },
        ],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.listings[0].sold_at).toBe('2026-08-22T00:00:00.000Z')
})

test('getProductDetail includes enrichment when a product_enrichment row exists', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 1,
              base_model: 'RTX 3060',
              variant_tier: null,
              new_price_low: null,
              new_price_high: null,
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
              enrichment_description: 'A mid-range GPU popular for 1080p gaming.',
              enrichment_value_drivers: 'VRAM size, boost clock, cooler quality',
              enrichment_has_trained_price_knowledge: true,
              enrichment_trained_price_low: '9000',
              enrichment_trained_price_high: '13000',
              enrichment_trained_price_currency: 'PHP',
              enrichment_model: 'llama-3.1-8b-instant',
              enrichment_checked_at: new Date('2026-08-21T00:00:00.000Z'),
            },
          ],
        }
      }
      return { rows: [] }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.enrichment).toEqual({
    description: 'A mid-range GPU popular for 1080p gaming.',
    value_drivers: 'VRAM size, boost clock, cooler quality',
    has_trained_price_knowledge: true,
    trained_price_low: 9000,
    trained_price_high: 13000,
    trained_price_currency: 'PHP',
    model: 'llama-3.1-8b-instant',
    checked_at: '2026-08-21T00:00:00.000Z',
  })
})

test('getProductDetail returns null enrichment when no product_enrichment row exists', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 1,
              base_model: 'RTX 3060',
              variant_tier: null,
              new_price_low: null,
              new_price_high: null,
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
              enrichment_description: null,
              enrichment_value_drivers: null,
              enrichment_has_trained_price_knowledge: null,
              enrichment_trained_price_low: null,
              enrichment_trained_price_high: null,
              enrichment_trained_price_currency: null,
              enrichment_model: null,
              enrichment_checked_at: null,
            },
          ],
        }
      }
      return { rows: [] }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.enrichment).toBeNull()
})

test('getListingDetail returns null when the listing does not exist', async () => {
  const db = fakeDb([])
  const result = await getListingDetail(db, '999')
  expect(result).toBeNull()
})

test('getListingDetail maps a full row, preferring stored_photo_urls over primary_photo_url, and coerces a Date listed_at to an ISO string', async () => {
  const db = fakeDb([
    {
      id: '123',
      title: 'RTX 3060 OC Asus',
      price_amount: '15000',
      price_currency: 'PHP',
      description: 'Barely used',
      condition: 'Used - Like New',
      location_city: 'Quezon City',
      listed_at: new Date('2026-08-01T00:00:00.000Z'),
      primary_photo_url: 'https://x/primary.jpg',
      stored_photo_urls: ['https://x/0.jpg', 'https://x/1.jpg'],
      product_id: 1,
      base_model: 'RTX 3060',
      variant_tier: null,
      sold_at: null,
      price_review_is_negotiable: null,
      price_review_low: null,
      price_review_high: null,
    },
  ])

  const result = await getListingDetail(db, '123')

  expect(result).toEqual({
    id: '123',
    title: 'RTX 3060 OC Asus',
    price_amount: 15000,
    price_currency: 'PHP',
    description: 'Barely used',
    condition: 'Used - Like New',
    location_city: 'Quezon City',
    listed_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: null,
    photo_urls: ['https://x/0.jpg', 'https://x/1.jpg'],
    product_id: 1,
    base_model: 'RTX 3060',
    variant_tier: null,
    sold_at: null,
    discount_percent: null,
    reference_price: null,
    price_review: null,
  })
})

test('getListingDetail computes discount against its siblings\' outlier-excluded median', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: '123',
              title: 'RTX 3060 OC Asus',
              price_amount: '12000',
              price_currency: 'PHP',
              description: null,
              condition: null,
              location_city: null,
              listed_at: null,
              last_seen_at: null,
              primary_photo_url: null,
              stored_photo_urls: null,
              product_id: 1,
              base_model: 'RTX 3060',
              variant_tier: null,
              sold_at: null,
              price_review_is_negotiable: null,
              price_review_low: null,
              price_review_high: null,
            },
          ],
        }
      }
      return { rows: [{ raw_median_price: '15000', sample_size: '5', clean_median_price: '15000' }] }
    },
  }

  const result = await getListingDetail(db, '123')

  expect(result?.discount_percent).toBe(20)
  expect(result?.reference_price).toBe(15000)
})

test('getListingDetail skips the sibling-median lookup entirely when the listing has no product_id', async () => {
  let queryCount = 0
  const db: QueryClient = {
    query: async (_sql, _params) => {
      queryCount += 1
      return {
        rows: [
          {
            id: '124',
            title: 'Unmatched listing',
            price_amount: '5000',
            price_currency: 'PHP',
            description: null,
            condition: null,
            location_city: null,
            listed_at: null,
            last_seen_at: null,
            primary_photo_url: null,
            stored_photo_urls: null,
            product_id: null,
            base_model: null,
            variant_tier: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
        ],
      }
    },
  }

  const result = await getListingDetail(db, '124')

  expect(queryCount).toBe(1)
  expect(result?.discount_percent).toBeNull()
})

test('getListingDetail includes price_review when a listing_price_review row exists', async () => {
  const db = fakeDb([
    {
      id: '1000000000000001',
      title: 'RTX 2060 6GB FOR SWAP ONLY',
      price_amount: '999999999',
      price_currency: 'PHP',
      description: 'swap only',
      condition: 'Used - Good',
      location_city: null,
      listed_at: null,
      primary_photo_url: null,
      stored_photo_urls: null,
      product_id: 17,
      base_model: 'RTX 2060',
      variant_tier: null,
      sold_at: null,
      price_review_is_negotiable: true,
      price_review_low: '7500',
      price_review_high: '9000',
    },
  ])

  const result = await getListingDetail(db, '1000000000000001')

  expect(result?.price_review).toEqual({
    is_negotiable: true,
    price_low: 7500,
    price_high: 9000,
  })
})

test('getListingDetail coerces a Date sold_at to an ISO string', async () => {
  const db = fakeDb([
    {
      id: '123',
      title: 'RTX 3060 OC Asus',
      price_amount: null,
      price_currency: null,
      description: null,
      condition: null,
      location_city: null,
      listed_at: null,
      primary_photo_url: null,
      stored_photo_urls: null,
      product_id: null,
      base_model: null,
      variant_tier: null,
      sold_at: new Date('2026-08-22T00:00:00.000Z'),
    },
  ])

  const result = await getListingDetail(db, '123')

  expect(result?.sold_at).toBe('2026-08-22T00:00:00.000Z')
})

test('getListingDetail falls back to primary_photo_url when stored_photo_urls is null or empty', async () => {
  const db = fakeDb([
    {
      id: '124',
      title: 'No carousel',
      price_amount: null,
      price_currency: null,
      description: null,
      condition: null,
      location_city: null,
      listed_at: null,
      primary_photo_url: 'https://x/primary.jpg',
      stored_photo_urls: null,
      product_id: null,
      base_model: null,
      variant_tier: null,
    },
  ])

  const result = await getListingDetail(db, '124')

  expect(result?.photo_urls).toEqual(['https://x/primary.jpg'])
})

test('getListingDetail returns an empty photo_urls array when neither is present', async () => {
  const db = fakeDb([
    {
      id: '125',
      title: 'No photos',
      price_amount: null,
      price_currency: null,
      description: null,
      condition: null,
      location_city: null,
      listed_at: null,
      primary_photo_url: null,
      stored_photo_urls: null,
      product_id: null,
      base_model: null,
      variant_tier: null,
    },
  ])

  const result = await getListingDetail(db, '125')

  expect(result?.photo_urls).toEqual([])
})
