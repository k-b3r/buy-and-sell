import type { DbClient, QueryClient } from '../../../platform/storage'
import { LOOKUP_OUTCOME_REASONS } from '../domain/exclusion-reasons'
import {
  applyEligibilityFromEnrichment,
  deleteExclusionOverride,
  dismissReview,
  excludeFromPricing,
  getExcludedProducts,
  getExclusionSummary,
  getUnexcludedBaseModels,
  includeInPricing,
} from './exclusion'

function mockDb(): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return undefined
      },
    },
  }
}

test('excludeFromPricing updates a single product by id', async () => {
  const { db, calls } = mockDb()

  await excludeFromPricing(db, { productId: 42 }, 'retail_not_found')

  expect(calls[0].sql).toBe(
    'UPDATE products SET price_lookup_excluded = true, price_lookup_excluded_reason = $1 WHERE id = $2' +
      ' AND NOT EXISTS (SELECT 1 FROM price_exclusion_overrides o WHERE o.product_id = products.id)',
  )
  expect(calls[0].params).toEqual(['retail_not_found', 42])
})

test('excludeFromPricing updates products matching any of the given base_model values', async () => {
  const { db, calls } = mockDb()

  await excludeFromPricing(db, { baseModels: ['Condo', 'House and Lot'] }, 'real_estate')

  expect(calls[0].sql).toBe(
    'UPDATE products SET price_lookup_excluded = true, price_lookup_excluded_reason = $1 WHERE base_model = ANY($2)' +
      ' AND NOT EXISTS (SELECT 1 FROM price_exclusion_overrides o WHERE o.product_id = products.id)',
  )
  expect(calls[0].params).toEqual(['real_estate', ['Condo', 'House and Lot']])
})

test('applyEligibilityFromEnrichment auto-excludes high-confidence non-specific products, then flags low-confidence ones for review', async () => {
  const { db, calls } = mockDb()

  await applyEligibilityFromEnrichment(db)

  expect(calls).toHaveLength(2)
  expect(calls[0].sql).toContain('UPDATE products p SET price_lookup_excluded = true')
  expect(calls[0].sql).toContain("price_lookup_excluded_reason = 'groq_generic'")
  expect(calls[0].sql).toContain("e.confidence = 'high'")
  expect(calls[0].sql).toContain('e.is_specific_product = false')
  expect(calls[0].sql).toContain('NOT p.price_lookup_excluded')
  expect(calls[1].sql).toContain("UPDATE products p SET price_lookup_review_status = 'needs_review'")
  expect(calls[1].sql).toContain("e.confidence = 'low'")
  expect(calls[1].sql).toContain('NOT p.price_lookup_excluded')
  expect(calls[1].sql).toContain('p.price_lookup_review_dismissed_at IS NULL')
})

test('getUnexcludedBaseModels returns distinct base_model values of products not yet excluded', async () => {
  const calls: string[] = []
  const db: DbClient = {
    query: async (sql: string) => {
      calls.push(sql)
      return { rows: [{ base_model: 'Coach Bag' }, { base_model: 'iPhone 13' }] }
    },
  }

  expect(await getUnexcludedBaseModels(db)).toEqual(['Coach Bag', 'iPhone 13'])
  expect(calls[0]).toBe('SELECT DISTINCT base_model FROM products WHERE NOT price_lookup_excluded ORDER BY base_model')
})

test('includeInPricing clears the flag in one statement, recording an override unless the reason was a lookup outcome', async () => {
  const { db, calls } = mockDb()

  await includeInPricing(db, 42)

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('INSERT INTO price_exclusion_overrides')
  expect(calls[0].sql).toContain('UPDATE products SET price_lookup_excluded = false')
  expect(calls[0].sql).toContain('NOT (reason = ANY($2))')
  expect(calls[0].params).toEqual([42, [...LOOKUP_OUTCOME_REASONS]])
})

test('deleteExclusionOverride removes the override row for the product', async () => {
  const { db, calls } = mockDb()

  await deleteExclusionOverride(db, 42)

  expect(calls[0].sql).toBe('DELETE FROM price_exclusion_overrides WHERE product_id = $1')
  expect(calls[0].params).toEqual([42])
})

test('getExclusionSummary groups excluded products by reason, biggest first, flagging retryable lookup-outcome reasons', async () => {
  const rows = [{ reason: 'too_generic', count: 3, retry: false }]
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows }
    },
  }

  const result = await getExclusionSummary(db)

  expect(calls[0].sql).toContain('WHERE price_lookup_excluded')
  expect(calls[0].sql).toContain('GROUP BY 1, 3 ORDER BY 2 DESC, 1')
  expect(calls[0].params).toEqual([[...LOOKUP_OUTCOME_REASONS]])
  expect(result).toEqual(rows)
})

test('getExcludedProducts pages one reason most listings first, defaulting to the first 50', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getExcludedProducts(db, 'too_generic')
  await getExcludedProducts(db, 'unknown', { offset: 100, limit: 10 })

  expect(calls[0].sql).toContain("COALESCE(p.price_lookup_excluded_reason, 'unknown') = $1")
  expect(calls[0].sql).toContain('ORDER BY listing_count DESC, p.base_model')
  expect(calls[0].sql).toContain('LIMIT $2 OFFSET $3')
  expect(calls[0].params).toEqual(['too_generic', 50, 0])
  expect(calls[1].params).toEqual(['unknown', 10, 100])
})

test('dismissReview clears price_lookup_review_status and stamps price_lookup_review_dismissed_at for one product', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await dismissReview(db, 12)

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('price_lookup_review_status = NULL')
  expect(calls[0].sql).toContain('price_lookup_review_dismissed_at = now()')
  expect(calls[0].sql).toContain('WHERE id = $1')
  expect(calls[0].params).toEqual([12])
})
