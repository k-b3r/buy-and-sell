import { existsSync, rmSync, readFileSync } from 'node:fs'
import { runNewPriceLookup } from '../src/new-price-lookup'
import { createLogger } from '../src/logger'
import type { ExaClient } from '../src/exa'
import type { DbClient } from '../src/db'
import type { NewPriceCandidate } from '../src/db'

const LOG_PATH = 'test/tmp-new-price.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function fakeExa(content: unknown): ExaClient {
  return { searchStructured: async () => content }
}

function fakeDb(): { db: DbClient; inserts: unknown[][] } {
  const inserts: unknown[][] = []
  return {
    inserts,
    db: {
      query: async (_sql: string, params: unknown[]) => {
        inserts.push(params)
        return { rows: [] }
      },
    },
  }
}

test('inserts a price_history row per product when a real price is found', async () => {
  const exa = fakeExa({ found: true, price_low: 14499, price_high: 19999 })
  const { db, inserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: NewPriceCandidate[] = [{ id: 2, base_model: 'Sony WH-1000XM4', variant_tier: null }]

  await runNewPriceLookup(exa, db, logger, products)

  expect(inserts).toHaveLength(1)
  expect(inserts[0]).toEqual([2, 14499, 19999, 'PHP', JSON.stringify({ found: true, price_low: 14499, price_high: 19999 }), 'exa_new_retail', 'New'])
})

test('a product with no reliable price found is logged and skipped, no row inserted', async () => {
  const exa = fakeExa({ found: false })
  const { db, inserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: NewPriceCandidate[] = [{ id: 5, base_model: 'Obscure Widget', variant_tier: null }]

  await runNewPriceLookup(exa, db, logger, products)

  expect(inserts).toHaveLength(0)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[WARN]')
})

test('an Exa request failure for one product is logged and does not stop the run', async () => {
  let call = 0
  const exa: ExaClient = {
    searchStructured: async () => {
      call += 1
      if (call === 1) throw new Error('network blip')
      return { found: true, price_low: 100, price_high: 200 }
    },
  }
  const { db, inserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: NewPriceCandidate[] = [
    { id: 1, base_model: 'A', variant_tier: null },
    { id: 2, base_model: 'B', variant_tier: null },
  ]

  await runNewPriceLookup(exa, db, logger, products, async () => {})

  expect(call).toBe(2)
  expect(inserts).toHaveLength(1)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[ERROR]')
})
