import { existsSync, rmSync } from 'node:fs'
import { createLogger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import { excludeIneligibleCategories } from './ineligible-categories'

const LOG_PATH = 'data/tmp-ineligible-categories.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function fakeDb(): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return { rows: [] }
      },
    },
  }
}

test('excludeIneligibleCategories writes one base_model exclusion per curated reason', async () => {
  const { db, calls } = fakeDb()

  await excludeIneligibleCategories(db, createLogger(LOG_PATH))

  expect(calls.map((c) => c.params[0])).toEqual([
    'real_estate',
    'too_generic',
    'needs_component_pricing',
    'parts_accessory',
    'service',
  ])
  for (const call of calls) {
    expect(call.sql).toContain('price_lookup_excluded = true')
    expect(call.sql).toContain('base_model = ANY($2)')
    expect(call.sql).not.toContain('price_lookup_review_status')
  }
})

test('excludeIneligibleCategories passes each reason its curated base_model values', async () => {
  const { db, calls } = fakeDb()

  await excludeIneligibleCategories(db, createLogger(LOG_PATH))

  const byReason = new Map(calls.map((c) => [c.params[0], c.params[1] as string[]]))
  expect(byReason.get('real_estate')).toContain('House and Lot')
  expect(byReason.get('too_generic')).toContain('Action Figure Lot')
  expect(byReason.get('needs_component_pricing')).toContain('Gaming PC Set')
  expect(byReason.get('parts_accessory')).toContain('iPhone Case')
  expect(byReason.get('service')).toContain('TV Repair Service')
})
