import { expect, test } from 'vitest'
import { getProductSummaries, getSoldCountsBySubCategory, getSubCategoryTree } from './product-list'
import type { QueryClient } from '../../platform/storage'
import { notJunkPriceSql } from '../pricing'

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
