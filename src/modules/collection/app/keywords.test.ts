import type { DbClient } from '../../../platform/storage'
import { loadCollectKeywords, loadRealEstateKeywords, DEFAULT_COLLECT_KEYWORDS } from './keywords'

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

test('loadCollectKeywords never falls back to defaults for loadRealEstateKeywords, an empty table just means no real estate pass', async () => {
  const { db } = mockDb([])
  expect(await loadRealEstateKeywords(db)).toEqual([])
})
