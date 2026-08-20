import { existsSync, rmSync } from 'node:fs'
import { computePriceRangeFromPrices, getListingPricesByProduct, runPriceFromListings } from '../src/price-from-listings'
import { createLogger } from '../src/logger'
import type { DbClient } from '../src/db'

const LOG_PATH = 'test/tmp-price-from-listings.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

test('computePriceRangeFromPrices drops junk prices under the floor before taking min/max', () => {
  const result = computePriceRangeFromPrices([12, 20, 14999, 15000, 15000])
  expect(result).toEqual({ low: 14999, high: 15000, currency: 'PHP', usedCount: 3 })
})

test('computePriceRangeFromPrices returns null when fewer than 2 valid prices remain after filtering', () => {
  expect(computePriceRangeFromPrices([12, 20])).toBeNull()
  expect(computePriceRangeFromPrices([15000])).toBeNull()
  expect(computePriceRangeFromPrices([])).toBeNull()
})

function fakeDb(rows: Record<string, unknown>[] = []): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
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

test('getListingPricesByProduct only selects products with at least 2 listings and groups their prices', async () => {
  const { db, calls } = fakeDb([
    { id: 1, base_model: 'RTX 3060', variant_tier: null, prices: ['14999', '15000', '35000'] },
    { id: 2, base_model: 'iPhone 13', variant_tier: null, prices: ['12', '20', '18000'] },
  ])

  const result = await getListingPricesByProduct(db)

  expect(calls[0].sql).toContain('HAVING count(l.id) >= 2')
  expect(result).toEqual([
    { id: 1, base_model: 'RTX 3060', variant_tier: null, prices: [14999, 15000, 35000] },
    { id: 2, base_model: 'iPhone 13', variant_tier: null, prices: [12, 20, 18000] },
  ])
})

test('runPriceFromListings inserts a listing_prices-sourced check per product with enough valid prices, skips the rest', async () => {
  const logger = createLogger(LOG_PATH)
  const { db, calls } = fakeDb()
  const products = [
    { id: 1, base_model: 'RTX 3060', variant_tier: null, prices: [12, 14999, 15000, 15000] },
    { id: 2, base_model: 'Obscure Thing', variant_tier: null, prices: [12, 20] }, // all junk, skip
  ]

  await runPriceFromListings(db, logger, products)

  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toHaveLength(1)
  expect(inserts[0].params).toEqual([1, 14999, 15000, 'PHP', 'computed from 3 of 4 listings (junk prices excluded)', 'listing_prices'])
})
