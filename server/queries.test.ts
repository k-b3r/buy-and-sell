import { expect, test } from 'vitest'
import { getAllSettings, updateSettings } from './queries'
import type { QueryClient } from '../src/platform/storage'

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
