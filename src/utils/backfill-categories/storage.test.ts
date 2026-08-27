import type { DbClient } from '../../platform/storage'
import { getCategoryBackfillCandidates, updateProductCategories } from './storage'

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

test('getCategoryBackfillCandidates returns products with no category assigned yet', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [{ id: 1, base_model: 'RTX 3060', variant_tier: null }] }
    },
  }

  const result = await getCategoryBackfillCandidates(db)

  expect(calls[0].sql).toContain('category_id IS NULL')
  expect(result).toEqual([{ id: 1, base_model: 'RTX 3060', variant_tier: null }])
})

test('updateProductCategories does nothing (no query) when given an empty array', async () => {
  const { db, calls } = mockDb()

  await updateProductCategories(db, [])

  expect(calls).toHaveLength(0)
})

test('updateProductCategories issues a single multi-row UPDATE for all assignments', async () => {
  const { db, calls } = mockDb()

  await updateProductCategories(db, [
    { id: 1, category: 'Gaming' },
    { id: 2, category: 'Audio' },
  ])

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toMatch(/^UPDATE products/)
  expect(calls[0].sql).toContain('FROM (VALUES')
  expect(calls[0].sql).toContain('JOIN categories')
  expect(calls[0].params).toEqual([1, 'Gaming', 2, 'Audio'])
})
