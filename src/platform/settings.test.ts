import type { DbClient, QueryClient } from './storage'
import { getAllSettings, loadSettings, SETTING_DEFAULTS, updateSettings } from './settings'

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

test('the LLM gateway is off by default so workers keep calling providers directly', () => {
  expect(SETTING_DEFAULTS['llm.gateway_enabled']).toBe(0)
})

test("real estate settings default to today's behavior (collection off, no recheck skipping)", () => {
  expect(SETTING_DEFAULTS['collect.re_keywords_enabled']).toBe(0)
  expect(SETTING_DEFAULTS['check_listings.re_recheck_min_days']).toBe(0)
  expect(SETTING_DEFAULTS['collect.re_every_n_laps']).toBe(3)
  expect(SETTING_DEFAULTS['collect.re_max_items']).toBe(50)
})

test('extract-real-estate settings have defaults', () => {
  expect(SETTING_DEFAULTS['extract_real_estate.batch_size']).toBe(10)
  expect(SETTING_DEFAULTS['extract_real_estate.loop_delay_ms']).toBe(300000)
})

test('getAllSettings maps rows into SettingRow shape, coercing value to a number', async () => {
  const db: QueryClient = {
    query: async () => ({
      rows: [{ key: 'collect.max_items_default', value: '100', updated_at: '2026-09-01T00:00:00Z' }],
    }),
  }

  const settings = await getAllSettings(db)

  expect(settings).toEqual([{ key: 'collect.max_items_default', value: 100, updatedAt: '2026-09-01T00:00:00Z' }])
})

test('updateSettings issues one batched UPDATE ... FROM (VALUES ...) for all rows', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await updateSettings(db, [
    { key: 'collect.pacing_min_ms', value: 3000 },
    { key: 'collect.pacing_max_ms', value: 9000 },
  ])

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('UPDATE settings')
  expect(calls[0].sql).toContain('FROM (VALUES')
  expect(calls[0].params).toEqual(['collect.pacing_min_ms', 3000, 'collect.pacing_max_ms', 9000])
})

test('updateSettings does nothing for an empty updates array', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await updateSettings(db, [])

  expect(calls).toHaveLength(0)
})
