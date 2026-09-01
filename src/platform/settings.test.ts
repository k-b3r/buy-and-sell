import type { DbClient } from './storage'
import { loadSettings, SETTING_DEFAULTS } from './settings'

function mockDb(rows: { key: string; value: number }[]): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
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

test('loadSettings returns DB-backed values for keys present in the table', async () => {
  const { db } = mockDb([{ key: 'collect.max_items_default', value: 250 }])
  const settings = await loadSettings(db, ['collect.max_items_default'])
  expect(settings).toEqual({ 'collect.max_items_default': 250 })
})

test('loadSettings falls back to SETTING_DEFAULTS for a key missing from the table', async () => {
  const { db } = mockDb([])
  const settings = await loadSettings(db, ['collect.max_items_default'])
  expect(settings).toEqual({ 'collect.max_items_default': SETTING_DEFAULTS['collect.max_items_default'] })
})

test('loadSettings mixes DB-backed and fallback values across multiple keys', async () => {
  const { db } = mockDb([{ key: 'check_listings.loop_delay_ms', value: 90000 }])
  const settings = await loadSettings(db, ['check_listings.loop_delay_ms', 'check_listings.limit_default'])
  expect(settings).toEqual({
    'check_listings.loop_delay_ms': 90000,
    'check_listings.limit_default': SETTING_DEFAULTS['check_listings.limit_default'],
  })
})

test('loadSettings queries only the requested keys via = ANY($1)', async () => {
  const { db, calls } = mockDb([])
  await loadSettings(db, ['collect.pacing_min_ms', 'collect.pacing_max_ms'])
  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('= ANY($1)')
  expect(calls[0].params).toEqual([['collect.pacing_min_ms', 'collect.pacing_max_ms']])
})
