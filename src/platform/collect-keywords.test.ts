import type { DbClient } from './storage'
import {
  loadCollectKeywords,
  loadRealEstateKeywords,
  planLapQueries,
  DEFAULT_COLLECT_KEYWORDS,
} from './collect-keywords'

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

test('loadCollectKeywords only loads general keywords', async () => {
  const { db, calls } = mockDb([{ keyword: 'rush sale' }])
  await loadCollectKeywords(db)
  expect(calls[0].sql).toContain("kind = 'general'")
})

test('loadRealEstateKeywords loads enabled real_estate keywords and never falls back to defaults', async () => {
  const { db, calls } = mockDb([])
  expect(await loadRealEstateKeywords(db)).toEqual([])
  expect(calls[0].sql).toContain("kind = 'real_estate'")
  expect(calls[0].sql).toContain('enabled')
})

const lapBase = {
  general: ['rush sale', 'preloved'],
  realEstate: ['house and lot'],
  reEveryNLaps: 3,
  reMaxItems: 50,
  defaultMaxItems: 100,
}

test('planLapQueries returns only general keywords, unchanged, while the real estate flag is off', () => {
  const plan = planLapQueries({ ...lapBase, lap: 1, reEnabled: 0 })
  expect(plan).toEqual([
    { query: 'rush sale', maxItems: 100 },
    { query: 'preloved', maxItems: 100 },
  ])
})

test('planLapQueries appends the real estate pass on lap 1 and every Nth lap, capped by reMaxItems', () => {
  expect(planLapQueries({ ...lapBase, lap: 1, reEnabled: 1 }).at(-1)).toEqual({ query: 'house and lot', maxItems: 50 })
  expect(planLapQueries({ ...lapBase, lap: 2, reEnabled: 1 })).toHaveLength(2)
  expect(planLapQueries({ ...lapBase, lap: 3, reEnabled: 1 })).toHaveLength(2)
  expect(planLapQueries({ ...lapBase, lap: 4, reEnabled: 1 })).toHaveLength(3)
})

test('planLapQueries keeps general keywords first so their order never changes', () => {
  const plan = planLapQueries({ ...lapBase, lap: 1, reEnabled: 1 })
  expect(plan.slice(0, 2).map((p) => p.query)).toEqual(['rush sale', 'preloved'])
})
