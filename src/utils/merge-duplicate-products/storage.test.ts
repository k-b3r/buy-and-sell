import type { DbClient } from '../../storage'
import { mergeDuplicateProduct } from './storage'

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

test('mergeDuplicateProduct reassigns listings, price history, and enrichment (skipping it if the survivor already has one), then deletes the loser', async () => {
  const { db, calls } = mockDb()

  await mergeDuplicateProduct(db, 100, 200)

  expect(calls).toHaveLength(5)
  expect(calls[0].sql).toBe('UPDATE listings SET product_id = $1 WHERE product_id = $2')
  expect(calls[0].params).toEqual([100, 200])
  expect(calls[1].sql).toBe('UPDATE product_price_history SET product_id = $1 WHERE product_id = $2')
  expect(calls[1].params).toEqual([100, 200])
  expect(calls[2].sql).toContain('UPDATE product_enrichment SET product_id = $1')
  expect(calls[2].sql).toContain('NOT EXISTS')
  expect(calls[2].params).toEqual([100, 200])
  expect(calls[3].sql).toBe('DELETE FROM product_enrichment WHERE product_id = $1')
  expect(calls[3].params).toEqual([200])
  expect(calls[4].sql).toBe('DELETE FROM products WHERE id = $1')
  expect(calls[4].params).toEqual([200])
})
