import type { DbClient } from '../../platform/storage'
import { applyEligibilityFromEnrichment, excludeFromPricing, excludeProductFromReview } from './exclusion'

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
    'UPDATE products SET price_lookup_excluded = true, price_lookup_excluded_reason = $1 WHERE id = $2',
  )
  expect(calls[0].params).toEqual(['retail_not_found', 42])
})

test('excludeFromPricing updates products matching any of the given base_model values', async () => {
  const { db, calls } = mockDb()

  await excludeFromPricing(db, { baseModels: ['Condo', 'House and Lot'] }, 'real_estate')

  expect(calls[0].sql).toBe(
    'UPDATE products SET price_lookup_excluded = true, price_lookup_excluded_reason = $1 WHERE base_model = ANY($2)',
  )
  expect(calls[0].params).toEqual(['real_estate', ['Condo', 'House and Lot']])
})

test('excludeProductFromReview sets price_lookup_excluded with a reason and clears the review flag', async () => {
  const { db, calls } = mockDb()

  await excludeProductFromReview(db, 12, 'manual_review')

  expect(calls[0].sql).toBe(
    'UPDATE products SET price_lookup_excluded = true, price_lookup_excluded_reason = $1, price_lookup_review_status = NULL WHERE id = $2',
  )
  expect(calls[0].params).toEqual(['manual_review', 12])
})

test('excludeProductFromReview rejects a reason outside the known exclusion reasons without writing', async () => {
  const { db, calls } = mockDb()

  await expect(excludeProductFromReview(db, 12, 'because')).rejects.toThrow('unknown price exclusion reason')
  expect(calls).toHaveLength(0)
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
