import { expect, test } from 'vitest'
import { getProductSummaryRows, getSoldCountsBySubCategory, getSubCategoryTree } from './product-list'
import type { QueryClient } from '../../../platform/storage'
import { notJunkPriceSql } from '../../pricing'

function fakeDb(rows: Record<string, unknown>[]): QueryClient {
  return { query: async () => ({ rows }) }
}

test('getProductSummaryRows defaults to limit 30, offset 0, no search filter', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaryRows(db)

  expect(capturedParams).toEqual([null, 30, 0])
})

test('getProductSummaryRows excludes price_lookup_excluded products from the discount computation', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await getProductSummaryRows(db)

  expect(capturedSql).toContain('NOT p.price_lookup_excluded')
})

test('getProductSummaryRows excludes placeholder-pattern prices from the price range and discount computation', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await getProductSummaryRows(db)

  const occurrences = capturedSql.split("'^(\\d+)\\1+$'").length - 1
  expect(occurrences).toBe(5) // product_median, price_min, price_max, price_avg, and the discount lateral
})

test('getProductSummaryRows excludes junk prices below the floor from the price range', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await getProductSummaryRows(db)

  for (const agg of ['min', 'max', 'avg']) {
    expect(capturedSql).toContain(`${agg}(l.price_amount) FILTER (WHERE ${notJunkPriceSql('l.price_amount')} AND`)
  }
})

test('getProductSummaryRows excludes sold listings from the listing aggregation join', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await getProductSummaryRows(db)

  expect(capturedSql).toContain('l.sold_at IS NULL')
})

test('getProductSummaryRows passes search as an ILIKE pattern and respects offset/limit options', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaryRows(db, { search: 'RTX', offset: 60, limit: 10 })

  expect(capturedSql).toContain('ILIKE')
  expect(capturedParams).toEqual(['%RTX%', 10, 60])
})

test('getProductSummaryRows filters by category when provided', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaryRows(db, { categories: ['Audio'] })

  expect(capturedSql).toContain('c.name = ANY($')
  expect(capturedParams).toEqual([null, ['Audio'], 30, 0])
})

test('getProductSummaryRows filters by multiple categories when provided', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaryRows(db, { categories: ['Audio', 'Gaming'] })

  expect(capturedParams).toEqual([null, ['Audio', 'Gaming'], 30, 0])
})

test('getProductSummaryRows omits the category filter when not provided', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaryRows(db)

  expect(capturedParams).toEqual([null, 30, 0])
})

test('getProductSummaryRows filters by sub-category when provided', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaryRows(db, { subCategories: ['Speakers'] })

  expect(capturedSql).toContain('sc.name = ANY($')
  expect(capturedParams).toEqual([null, ['Speakers'], 30, 0])
})

test('getProductSummaryRows filters by multiple sub-categories when provided', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaryRows(db, { subCategories: ['Speakers', 'Consoles'] })

  expect(capturedParams).toEqual([null, ['Speakers', 'Consoles'], 30, 0])
})

test('getProductSummaryRows omits the sub-category filter when not provided', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaryRows(db)

  expect(capturedParams).toEqual([null, 30, 0])
})

test('getProductSummaryRows combines category and sub-category filters, category param first', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaryRows(db, { categories: ['Audio'], subCategories: ['Speakers'] })

  expect(capturedParams).toEqual([null, ['Audio'], ['Speakers'], 30, 0])
})

test('getProductSummaryRows treats an empty/whitespace search as no filter', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaryRows(db, { search: '   ' })

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
