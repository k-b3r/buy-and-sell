import type { DbClient } from './storage'
import { loadCollectKeywords, DEFAULT_COLLECT_KEYWORDS } from './collect-keywords'

function mockDb(rows: { keyword: string }[]): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return { rows }
      },
    },
  }
}

test('loadCollectKeywords returns the DB-backed list when rows exist', async () => {
  const { db } = mockDb([{ keyword: 'garage sale' }, { keyword: 'rush sale' }])
  expect(await loadCollectKeywords(db)).toEqual(['garage sale', 'rush sale'])
})

test('loadCollectKeywords falls back to DEFAULT_COLLECT_KEYWORDS when the table is empty', async () => {
  const { db } = mockDb([])
  expect(await loadCollectKeywords(db)).toEqual(DEFAULT_COLLECT_KEYWORDS)
})

test('loadCollectKeywords queries the collect_keywords table', async () => {
  const { db, calls } = mockDb([])
  await loadCollectKeywords(db)
  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('FROM collect_keywords')
})

test('loadCollectKeywords only selects enabled keywords', async () => {
  const { db, calls } = mockDb([])
  await loadCollectKeywords(db)
  expect(calls[0].sql).toContain('WHERE enabled')
})
