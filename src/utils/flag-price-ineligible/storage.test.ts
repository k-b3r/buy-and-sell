import type { DbClient } from '../../platform/storage'
import { flagPriceLookupExcluded } from './storage'

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

test('flagPriceLookupExcluded updates products matching any of the given base_model values', async () => {
  const { db, calls } = mockDb()

  await flagPriceLookupExcluded(db, ['Condo', 'House and Lot'], 'real_estate')

  expect(calls[0].sql).toMatch(/^UPDATE products SET price_lookup_excluded = true/)
  expect(calls[0].params).toEqual(['real_estate', ['Condo', 'House and Lot']])
})
