import { expect, test } from 'vitest'
import {
  getProductSummaries,
  getProductDetail,
  getListingDetail,
  saveListing,
  unsaveListing,
  getSavedListings,
  getSoldCountsBySubCategory,
  getSubCategoryTree,
  getProductsNeedingReview,
  markProductReviewed,
  excludeProductFromReview,
  getAllSettings,
  updateSettings,
  getCollectKeywords,
  replaceCollectKeywords,
} from './queries'
import type { QueryClient } from '../src/platform/storage'

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
  expect(occurrences).toBe(5) // product_median, price_min, price_max, price_avg, and the discount lateral
})

test('getProductSummaries excludes sold listings from the listing aggregation join', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await getProductSummaries(db)

  expect(capturedSql).toContain('l.sold_at IS NULL')
})

test('getListingDetail excludes placeholder-pattern prices from the sibling median query', async () => {
  const db: QueryClient = {
    query: async (sql: string) => {
      if (sql.includes('product_prices')) {
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

test('getListingDetail hides price_amount entirely when it is a magnitude outlier vs. the sibling median', async () => {
  const db: QueryClient = {
    query: async (sql: string) => {
      if (sql.includes('product_prices')) {
        return { rows: [{ raw_median_price: '15000', sample_size: '5', clean_median_price: '15000' }] }
      }
      return {
        rows: [
          {
            id: '123',
            title: 'x',
            price_amount: '999999999',
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

  const result = await getListingDetail(db, '123')

  expect(result?.price_amount).toBeNull()
  expect(result?.discount_percent).toBeNull()
})

test('getListingDetail keeps a normal in-range price_amount as-is', async () => {
  const db: QueryClient = {
    query: async (sql: string) => {
      if (sql.includes('product_prices')) {
        return { rows: [{ raw_median_price: '15000', sample_size: '5', clean_median_price: '15000' }] }
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

  const result = await getListingDetail(db, '123')

  expect(result?.price_amount).toBe(12000)
})

test('getListingDetail surfaces the verification reasoning for a listing with a verified discount notification', async () => {
  let mainSql = ''
  const db: QueryClient = {
    query: async (sql: string) => {
      if (sql.includes('product_prices')) {
        return { rows: [{ raw_median_price: null, sample_size: '0', clean_median_price: null }] }
      }
      mainSql = sql
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
            verification_reasoning: 'Fresh market ~₱18k; the asking price genuinely undercuts it.',
          },
        ],
      }
    },
  }

  const result = await getListingDetail(db, '123')

  expect(mainSql).toContain('dn.verification_reasoning')
  expect(mainSql).toContain('dn.verified_at IS NOT NULL')
  expect(result?.verification_reasoning).toBe('Fresh market ~₱18k; the asking price genuinely undercuts it.')
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

test('getProductSummaries filters by category when provided', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaries(db, { categories: ['Audio'] })

  expect(capturedSql).toContain('c.name = ANY($')
  expect(capturedParams).toEqual([null, ['Audio'], 30, 0])
})

test('getProductSummaries filters by multiple categories when provided', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaries(db, { categories: ['Audio', 'Gaming'] })

  expect(capturedParams).toEqual([null, ['Audio', 'Gaming'], 30, 0])
})

test('getProductSummaries omits the category filter when not provided', async () => {
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

test('getProductSummaries filters by sub-category when provided', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaries(db, { subCategories: ['Speakers'] })

  expect(capturedSql).toContain('sc.name = ANY($')
  expect(capturedParams).toEqual([null, ['Speakers'], 30, 0])
})

test('getProductSummaries filters by multiple sub-categories when provided', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaries(db, { subCategories: ['Speakers', 'Consoles'] })

  expect(capturedParams).toEqual([null, ['Speakers', 'Consoles'], 30, 0])
})

test('getProductSummaries omits the sub-category filter when not provided', async () => {
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

test('getProductSummaries combines category and sub-category filters, category param first', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaries(db, { categories: ['Audio'], subCategories: ['Speakers'] })

  expect(capturedParams).toEqual([null, ['Audio'], ['Speakers'], 30, 0])
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
        listed_at: null,
        price_review: null,
        discount_percent: null,
        reference_price: null,
      },
    ],
  })
})

test("getProductDetail prefers a listing's stored_photo_urls over its primary_photo_url for the card thumbnail", async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 1,
              base_model: 'Sony WH-1000XM6',
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
      return {
        rows: [
          {
            id: '123',
            title: 'Sony WH-1000XM6',
            price_amount: '15000',
            // primary_photo_url is Facebook's own CDN link and expires;
            // stored_photo_urls is the durable R2-hosted copy and must win.
            primary_photo_url: 'https://scontent.fmnl30-3.fna.fbcdn.net/expired.jpg',
            stored_photo_urls: ['https://pub-xyz.r2.dev/listings/123/0.jpg'],
            condition: null,
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

  expect(result?.listings[0].primary_photo_url).toBe('https://pub-xyz.r2.dev/listings/123/0.jpg')
})

test('getProductDetail surfaces the verification reasoning for a listing with a verified discount notification, null for one without', async () => {
  let call = 0
  let listingsSql = ''
  const db: QueryClient = {
    query: async (sql: string) => {
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
      listingsSql = sql
      return {
        rows: [
          {
            id: '123',
            title: 'flagged one',
            price_amount: '12000',
            condition: null,
            sold_at: null,
            verification_reasoning: 'Genuinely underpriced vs fresh market data.',
          },
          {
            id: '456',
            title: 'never flagged',
            price_amount: '13000',
            condition: null,
            sold_at: null,
            verification_reasoning: null,
          },
        ],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(listingsSql).toContain('dn.verification_reasoning')
  expect(listingsSql).toContain('dn.verified_at IS NOT NULL')
  expect(result?.listings.find((l) => l.id === '123')?.verification_reasoning).toBe(
    'Genuinely underpriced vs fresh market data.',
  )
  expect(result?.listings.find((l) => l.id === '456')?.verification_reasoning).toBeNull()
})

test("getProductDetail computes each listing's discount against the outlier-excluded median of its siblings", async () => {
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
          {
            id: 'a',
            title: 'A',
            price_amount: '12000',
            primary_photo_url: null,
            condition: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
          {
            id: 'b',
            title: 'B',
            price_amount: '15000',
            primary_photo_url: null,
            condition: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
          {
            id: 'c',
            title: 'C',
            price_amount: '18000',
            primary_photo_url: null,
            condition: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
          {
            id: 'd',
            title: 'D (swap only placeholder)',
            price_amount: '999999999',
            primary_photo_url: null,
            condition: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
          {
            id: 'e',
            title: 'E (fake attention price)',
            price_amount: '123456',
            primary_photo_url: null,
            condition: null,
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

  expect(result?.listings.map((l) => [l.id, l.discount_percent, l.reference_price])).toEqual([
    ['a', 20, 15000],
    ['b', 0, 15000],
    ['c', -20, 15000],
    ['d', null, null],
    ['e', null, null],
  ])
  // 'd' is a magnitude outlier (999999999 vs a 15000 median) and 'e' is a
  // placeholder digit pattern (123456, an embedded ascending run) - both get
  // their price hidden entirely, matching enrich-listing-prices.ts's full
  // candidate criteria (magnitude outlier OR placeholder pattern), not just
  // the magnitude check.
  expect(result?.listings.map((l) => [l.id, l.price_amount])).toEqual([
    ['a', 12000],
    ['b', 15000],
    ['c', 18000],
    ['d', null],
    ['e', null],
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
          {
            id: 'a',
            title: 'Sale',
            price_amount: '1000',
            primary_photo_url: null,
            condition: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
          {
            id: 'b',
            title: 'Rush Sale',
            price_amount: '5000',
            primary_photo_url: null,
            condition: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
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
    recent_sales: [],
    similar_listings: [],
  })
})

test("getListingDetail computes discount against its siblings' outlier-excluded median", async () => {
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

test('getListingDetail still runs the sibling-median query (in parallel, keyed off listingId) when the listing has no product_id, and gets no discount back', async () => {
  let queryCount = 0
  const db: QueryClient = {
    query: async (sql: string) => {
      queryCount += 1
      if (sql.includes('product_prices'))
        return { rows: [{ raw_median_price: null, sample_size: '0', clean_median_price: null }] }
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

  expect(queryCount).toBe(2)
  expect(result?.discount_percent).toBeNull()
  expect(result?.recent_sales).toEqual([])
  expect(result?.similar_listings).toEqual([])
})

test('getListingDetail populates recent_sales/similar_listings only for tiers that clear their own sample threshold', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: '123',
              title: 'iPhone 13',
              price_amount: '10000',
              price_currency: 'PHP',
              description: null,
              condition: null,
              location_city: null,
              listed_at: null,
              last_seen_at: null,
              primary_photo_url: null,
              stored_photo_urls: null,
              product_id: 1,
              base_model: 'iPhone 13',
              variant_tier: null,
              sold_at: null,
              price_review_is_negotiable: null,
              price_review_low: null,
              price_review_high: null,
            },
          ],
        }
      }
      if (call === 2) return { rows: [{ raw_median_price: '12000', sample_size: '5', clean_median_price: '12000' }] } // sibling median
      if (call === 3) return { rows: [{ sample_size: '4', clean_median_price: '11000' }] } // getSoldComparablePrice: clears n>=3
      if (call === 4) return { rows: [{ sample_size: '1', clean_median_price: null }] } // getPeerMedianPrice: fails n>=2
      if (call === 5) {
        return {
          rows: [
            {
              listing_id: 'l2',
              title: 'Sold iPhone 13',
              price_amount: '11500',
              primary_photo_url: 'https://x/s.jpg',
              stored_photo_urls: null,
              date: new Date('2026-08-20T00:00:00Z'),
            },
          ],
        }
      }
      return { rows: [] } // call 6: peer comparable rows - unused, peer tier didn't clear its threshold
    },
  }

  const result = await getListingDetail(db, '123')

  expect(result?.recent_sales).toEqual([
    {
      listing_id: 'l2',
      title: 'Sold iPhone 13',
      price_amount: 11500,
      photo_url: 'https://x/s.jpg',
      date: '2026-08-20T00:00:00.000Z',
    },
  ])
  expect(result?.similar_listings).toEqual([])
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

test('getListingDetail sets is_saved true when a saved_listings row exists', async () => {
  const db = fakeDb([
    {
      id: '123',
      title: 'x',
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
      is_saved: true,
    },
  ])

  const result = await getListingDetail(db, '123')

  expect(result?.is_saved).toBe(true)
})

test('saveListing inserts into saved_listings, ignoring an already-saved listing', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await saveListing(db, '123')

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('INSERT INTO saved_listings')
  expect(calls[0].sql).toContain('ON CONFLICT (listing_id) DO NOTHING')
  expect(calls[0].params).toEqual(['123'])
})

test('unsaveListing deletes the saved_listings row for the given listing', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await unsaveListing(db, '123')

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('DELETE FROM saved_listings')
  expect(calls[0].params).toEqual(['123'])
})

test('getSavedListings maps joined rows into SavedListingSummary shape, most recently saved first', async () => {
  const db = fakeDb([
    {
      id: '123',
      title: 'Sony WH-1000XM6',
      price_amount: '15000',
      primary_photo_url: 'https://x/0.jpg',
      stored_photo_urls: null,
      condition: 'Used - like new',
      sold_at: null,
      product_id: 1,
      base_model: 'Sony WH-1000XM6',
      variant_tier: null,
      saved_at: '2026-08-25T00:00:00.000Z',
    },
  ])

  const result = await getSavedListings(db)

  expect(result).toEqual([
    {
      id: '123',
      title: 'Sony WH-1000XM6',
      price_amount: 15000,
      primary_photo_url: 'https://x/0.jpg',
      condition: 'Used - like new',
      sold_at: null,
      product_id: 1,
      base_model: 'Sony WH-1000XM6',
      variant_tier: null,
      saved_at: '2026-08-25T00:00:00.000Z',
    },
  ])
})

test('getSavedListings prefers stored_photo_urls over primary_photo_url', async () => {
  const db = fakeDb([
    {
      id: '123',
      title: 'x',
      price_amount: null,
      primary_photo_url: 'https://x/expired.jpg',
      stored_photo_urls: ['https://r2/0.jpg'],
      condition: null,
      sold_at: null,
      product_id: null,
      base_model: null,
      variant_tier: null,
      saved_at: '2026-08-25T00:00:00.000Z',
    },
  ])

  const result = await getSavedListings(db)

  expect(result[0].primary_photo_url).toBe('https://r2/0.jpg')
})

test('getSoldCountsBySubCategory queries only sold listings, zero-filling weeks in SQL', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await getSoldCountsBySubCategory(db)

  expect(capturedSql).toContain('sold_at IS NOT NULL')
  expect(capturedSql).toContain('CROSS JOIN weeks')
})

test("getSoldCountsBySubCategory groups rows under their category+subCategory, most-sold first, carrying each week's avg price", async () => {
  // Simulates rows already ordered by the SQL (highest total_sold first at
  // both levels, weeks ascending within a group) - grouping is a
  // consecutive-run collapse, not a re-sort.
  const db = fakeDb([
    {
      category: 'Vehicles',
      sub_category: 'Motorcycles',
      total_sold: '3',
      week_start: new Date('2026-08-10T00:00:00.000Z'),
      count: '2',
      avg_price: '7500',
    },
    {
      category: 'Vehicles',
      sub_category: 'Motorcycles',
      total_sold: '3',
      week_start: new Date('2026-08-17T00:00:00.000Z'),
      count: '1',
      avg_price: '9000',
    },
    {
      category: 'Vehicles',
      sub_category: 'Bicycles',
      total_sold: '1',
      week_start: new Date('2026-08-10T00:00:00.000Z'),
      count: '0',
      avg_price: null,
    },
    {
      category: 'Vehicles',
      sub_category: 'Bicycles',
      total_sold: '1',
      week_start: new Date('2026-08-17T00:00:00.000Z'),
      count: '1',
      avg_price: '15000',
    },
  ])

  const result = await getSoldCountsBySubCategory(db)

  expect(result).toEqual([
    {
      category: 'Vehicles',
      subCategory: 'Motorcycles',
      totalSold: 3,
      weeklyCounts: [
        { weekStart: '2026-08-10T00:00:00.000Z', count: 2, avgPrice: 7500 },
        { weekStart: '2026-08-17T00:00:00.000Z', count: 1, avgPrice: 9000 },
      ],
    },
    {
      category: 'Vehicles',
      subCategory: 'Bicycles',
      totalSold: 1,
      weeklyCounts: [
        { weekStart: '2026-08-10T00:00:00.000Z', count: 0, avgPrice: null },
        { weekStart: '2026-08-17T00:00:00.000Z', count: 1, avgPrice: 15000 },
      ],
    },
  ])
})

test('getSoldCountsBySubCategory excludes placeholder-pattern prices from the weekly average', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await getSoldCountsBySubCategory(db)

  expect(capturedSql).toContain("'^(\\d+)\\1+$'")
})

test('getSoldCountsBySubCategory returns an empty array when nothing is sold', async () => {
  const db = fakeDb([])
  const result = await getSoldCountsBySubCategory(db)
  expect(result).toEqual([])
})

test('getSubCategoryTree joins leaves to their parent via categories.parent_id, scoped to the 14 categories, plus Other', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return {
        rows: [
          { sub_category: 'Speakers', parent_category: 'Audio' },
          { sub_category: 'Other', parent_category: 'Other' },
        ],
      }
    },
  }

  const result = await getSubCategoryTree(db)

  expect(capturedSql).toContain('sub.parent_id')
  expect(capturedSql).toContain('parent.name = ANY($1)')
  expect(capturedParams).toEqual([expect.arrayContaining(['Audio', 'Other'])])
  expect(result).toEqual([
    { subCategory: 'Speakers', parentCategory: 'Audio' },
    { subCategory: 'Other', parentCategory: 'Other' },
  ])
})

test('getProductsNeedingReview queries only price_lookup_review_status = needs_review, with enrichment when present', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return {
        rows: [
          {
            id: 12,
            base_model: 'Generic Wireless Earbuds',
            variant_tier: null,
            category: 'Audio',
            sub_category: 'Headphones',
            sample_photo_url: 'https://cdn/12.jpg',
            new_price_low: '1500',
            new_price_high: '2000',
            secondhand_price_low: null,
            secondhand_price_high: null,
            price_history: [
              {
                id: 501,
                kind: 'new',
                price_low: '1500',
                price_high: '2000',
                price_currency: 'PHP',
                source: 'manual_new_retail',
                condition: null,
                checked_at: new Date('2026-08-25T00:00:00.000Z'),
              },
              {
                id: 500,
                kind: 'secondhand',
                price_low: '800',
                price_high: '1200',
                price_currency: 'PHP',
                source: 'web_search',
                condition: 'Used',
                checked_at: new Date('2026-08-18T00:00:00.000Z'),
              },
            ],
            description: 'Unbranded true-wireless earbuds',
            value_drivers: 'battery life, case charging',
            has_trained_price_knowledge: false,
            trained_price_low: null,
            trained_price_high: null,
            trained_price_currency: null,
            model: 'groq-1',
            checked_at: new Date('2026-08-20T00:00:00.000Z'),
            confidence: 'low',
            is_specific_product: null,
          },
          {
            id: 13,
            base_model: 'Unknown Gadget',
            variant_tier: null,
            category: 'Other',
            sub_category: 'Other',
            sample_photo_url: null,
            new_price_low: null,
            new_price_high: null,
            secondhand_price_low: null,
            secondhand_price_high: null,
            price_history: null,
            description: null,
            value_drivers: null,
            has_trained_price_knowledge: null,
            trained_price_low: null,
            trained_price_high: null,
            trained_price_currency: null,
            model: null,
            checked_at: null,
            confidence: null,
            is_specific_product: null,
          },
        ],
      }
    },
  }

  const result = await getProductsNeedingReview(db)

  expect(capturedSql).toContain("p.price_lookup_review_status = 'needs_review'")
  expect(result).toEqual([
    {
      id: 12,
      base_model: 'Generic Wireless Earbuds',
      variant_tier: null,
      category: 'Audio',
      sub_category: 'Headphones',
      sample_photo_url: 'https://cdn/12.jpg',
      new_price_low: 1500,
      new_price_high: 2000,
      secondhand_price_low: null,
      secondhand_price_high: null,
      price_history: [
        {
          id: 501,
          kind: 'new',
          price_low: 1500,
          price_high: 2000,
          price_currency: 'PHP',
          source: 'manual_new_retail',
          condition: null,
          checked_at: '2026-08-25T00:00:00.000Z',
        },
        {
          id: 500,
          kind: 'secondhand',
          price_low: 800,
          price_high: 1200,
          price_currency: 'PHP',
          source: 'web_search',
          condition: 'Used',
          checked_at: '2026-08-18T00:00:00.000Z',
        },
      ],
      enrichment: {
        description: 'Unbranded true-wireless earbuds',
        value_drivers: 'battery life, case charging',
        has_trained_price_knowledge: false,
        trained_price_low: null,
        trained_price_high: null,
        trained_price_currency: null,
        model: 'groq-1',
        checked_at: '2026-08-20T00:00:00.000Z',
        confidence: 'low',
        is_specific_product: null,
      },
    },
    {
      id: 13,
      base_model: 'Unknown Gadget',
      variant_tier: null,
      category: 'Other',
      sub_category: 'Other',
      sample_photo_url: null,
      new_price_low: null,
      new_price_high: null,
      secondhand_price_low: null,
      secondhand_price_high: null,
      price_history: [],
      enrichment: null,
    },
  ])
})

test('markProductReviewed clears price_lookup_review_status back to NULL for one product', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await markProductReviewed(db, 12)

  expect(capturedSql).toContain('price_lookup_review_status = NULL')
  expect(capturedSql).toContain('price_lookup_review_dismissed_at = now()')
  expect(capturedSql).toContain('WHERE id = $1')
  expect(capturedParams).toEqual([12])
})

test('excludeProductFromReview sets price_lookup_excluded with a reason and clears the review flag', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await excludeProductFromReview(db, 12, 'manual_review')

  expect(capturedSql).toContain('price_lookup_excluded = true')
  expect(capturedSql).toContain('price_lookup_excluded_reason = $1')
  expect(capturedSql).toContain('price_lookup_review_status = NULL')
  expect(capturedParams).toEqual(['manual_review', 12])
})

test('getAllSettings maps rows into SettingRow shape, coercing value to a number', async () => {
  const db: QueryClient = {
    query: async () => ({
      rows: [{ key: 'collect.max_items_default', value: '100', updated_at: '2026-09-01T00:00:00Z' }],
    }),
  }

  const settings = await getAllSettings(db)

  expect(settings).toEqual([{ key: 'collect.max_items_default', value: 100, updatedAt: '2026-09-01T00:00:00Z' }])
})

test('updateSettings issues one batched UPDATE ... FROM (VALUES ...) for all rows', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await updateSettings(db, [
    { key: 'collect.pacing_min_ms', value: 3000 },
    { key: 'collect.pacing_max_ms', value: 9000 },
  ])

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('UPDATE settings')
  expect(calls[0].sql).toContain('FROM (VALUES')
  expect(calls[0].params).toEqual(['collect.pacing_min_ms', 3000, 'collect.pacing_max_ms', 9000])
})

test('updateSettings does nothing for an empty updates array', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await updateSettings(db, [])

  expect(calls).toHaveLength(0)
})

test('getCollectKeywords maps rows into keyword + enabled entries', async () => {
  const db: QueryClient = {
    query: async () => ({
      rows: [
        { keyword: 'moving out', enabled: true },
        { keyword: 'rush sale', enabled: false },
      ],
    }),
  }

  expect(await getCollectKeywords(db)).toEqual([
    { keyword: 'moving out', enabled: true },
    { keyword: 'rush sale', enabled: false },
  ])
})

test('replaceCollectKeywords deletes all rows then inserts the new list in one batch', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await replaceCollectKeywords(db, [
    { keyword: 'rush sale', enabled: true },
    { keyword: 'garage sale', enabled: false },
  ])

  expect(calls).toHaveLength(2)
  expect(calls[0].sql).toContain('DELETE FROM collect_keywords')
  expect(calls[1].sql).toContain('INSERT INTO collect_keywords')
  expect(calls[1].sql).toContain('enabled')
  expect(calls[1].params).toEqual(['rush sale', true, 'garage sale', false])
})

test('replaceCollectKeywords still deletes when the new list is empty, skips the insert', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await replaceCollectKeywords(db, [])

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('DELETE FROM collect_keywords')
})

test('getCollectKeywords and replaceCollectKeywords only touch general keywords', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getCollectKeywords(db)
  await replaceCollectKeywords(db, [{ keyword: 'rush sale', enabled: true }])

  expect(calls[0].sql).toContain("kind = 'general'")
  expect(calls[1].sql).toContain("DELETE FROM collect_keywords WHERE kind = 'general'")
})
