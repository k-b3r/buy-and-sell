import { expect, test } from 'vitest'
import { getProductDetail, getProductSummaries, getSoldCountsBySubCategory, getSubCategoryTree } from './queries'
import type { QueryClient } from '../../platform/storage'
import { notJunkPriceSql, peerListingSql } from '../pricing'

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

test('getProductSummaries excludes junk prices below the floor from the price range', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await getProductSummaries(db)

  for (const agg of ['min', 'max', 'avg']) {
    expect(capturedSql).toContain(`${agg}(l.price_amount) FILTER (WHERE ${notJunkPriceSql('l.price_amount')} AND`)
  }
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
    pricing_excluded_reason: null,
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
        is_repost: false,
      },
    ],
  })
})

test('getProductDetail flags every listing that shares a normalized title with another, across the full set', async () => {
  let call = 0
  const listing = (id: string, title: string) => ({ id, title, price_amount: '15000', sold_at: null })
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) return { rows: [{ id: 1, base_model: 'RTX 3060', variant_tier: null }] }
      return {
        rows: [listing('a', 'RTX 3060 OC'), listing('b', 'Other GPU'), listing('c', '  rtx 3060 oc ')],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.listings.map((l) => [l.id, l.is_repost])).toEqual([
    ['a', true],
    ['b', false],
    ['c', true],
  ])
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
            is_peer: true,
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
            is_peer: true,
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
            is_peer: true,
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
            is_peer: true,
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
            is_peer: true,
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

test('getProductDetail takes the median over peer listings only, still scoring and showing a long-sold listing against it', async () => {
  let call = 0
  const listing = (id: string, price: string, isPeer: boolean) => ({
    id,
    title: id,
    price_amount: price,
    primary_photo_url: null,
    condition: null,
    sold_at: isPeer ? null : '2026-01-01T00:00:00Z',
    is_peer: isPeer,
    price_review_is_negotiable: null,
    price_review_low: null,
    price_review_high: null,
  })
  const db: QueryClient = {
    query: async (sql) => {
      call += 1
      if (call === 1) return { rows: [{ id: 1, base_model: 'RTX 3060', price_lookup_excluded: false }] }
      expect(sql).toContain(`${peerListingSql('l')} AS is_peer`)
      return {
        rows: [
          listing('a', '10000', true),
          listing('b', '10000', true),
          listing('c', '10000', true),
          listing('old1', '40000', false),
          listing('old2', '40000', false),
          listing('old3', '40000', false),
        ],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.listings.map((l) => [l.id, l.discount_percent, l.reference_price])).toEqual([
    ['a', 0, 10000],
    ['b', 0, 10000],
    ['c', 0, 10000],
    ['old1', -300, 10000],
    ['old2', -300, 10000],
    ['old3', -300, 10000],
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

test('getSoldCountsBySubCategory excludes junk prices below the floor from the weekly average', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await getSoldCountsBySubCategory(db)

  expect(capturedSql).toContain(`WHERE l.price_amount IS NOT NULL AND ${notJunkPriceSql('l.price_amount')}`)
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
