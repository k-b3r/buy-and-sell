import { existsSync, rmSync } from 'node:fs'
import { runPriceFromListings } from './run'
import { createLogger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'

const LOG_PATH = 'data/tmp-price-from-listings.log'

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

test('runPriceFromListings inserts one listing_prices row per product/condition group with enough valid prices, skips the rest, tags the condition', async () => {
  const logger = createLogger(LOG_PATH)
  const { db, calls } = fakeDb()
  const groups = [
    { id: 1, base_model: 'RTX 3060', variant_tier: null, condition: 'Used - Good', prices: [12, 14999, 15000, 15000] },
    { id: 1, base_model: 'RTX 3060', variant_tier: null, condition: 'New', prices: [18000, 18200, 18500] },
    { id: 2, base_model: 'Obscure Thing', variant_tier: null, condition: 'Used - Fair', prices: [12, 20] }, // all junk, skip
  ]

  await runPriceFromListings(db, logger, groups)

  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toHaveLength(2)
  expect(inserts[0].params).toEqual([
    1,
    14999,
    15000,
    'PHP',
    'computed from 3 of 4 "Used - Good" listings (junk prices excluded)',
    'listing_prices',
    'Used - Good',
    null,
    null,
    null,
  ])
  expect(inserts[1].params).toEqual([
    1,
    18000,
    18500,
    'PHP',
    'computed from 3 of 3 "New" listings (junk prices excluded)',
    'listing_prices',
    'New',
    null,
    null,
    null,
  ])
})
