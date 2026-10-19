import type { DbClient } from '../../../platform/storage'
import { excludeProductFromReview } from './exclusion'

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

test('excludeProductFromReview drops any override, then excludes with a reason and clears the review flag', async () => {
  const { db, calls } = mockDb()

  await excludeProductFromReview(db, 12, 'manual_review')

  expect(calls[0]).toEqual({ sql: 'DELETE FROM price_exclusion_overrides WHERE product_id = $1', params: [12] })
  expect(calls[1].sql).toBe(
    'UPDATE products SET price_lookup_excluded = true, price_lookup_excluded_reason = $1, price_lookup_review_status = NULL WHERE id = $2' +
      ' AND NOT EXISTS (SELECT 1 FROM price_exclusion_overrides o WHERE o.product_id = products.id)',
  )
  expect(calls[1].params).toEqual(['manual_review', 12])
})
