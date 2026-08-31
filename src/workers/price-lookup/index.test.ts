import { existsSync, rmSync } from 'node:fs'
import { runPriceLookup } from './index'
import type { PriceLookupClients } from './index'
import { createLogger } from '../../platform/logger'
import type { ExaClient, TavilyClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { PriceLookupCandidate } from '../../domains/marketplace'

const LOG_PATH = 'data/tmp-price-lookup.log'

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

// Default: Exa succeeds for both retail and secondhand, distinguished by
// query wording (matches buildExaQuery's "retail"/"secondhand used market"
// phrasing) - realistic enough to exercise both insert paths from one fake.
function fakeClients(overrides: Partial<PriceLookupClients> = {}): { clients: PriceLookupClients; exaCalls: string[]; tavilyCalls: string[] } {
  const exaCalls: string[] = []
  const tavilyCalls: string[] = []

  const exa: ExaClient = {
    searchStructured: async (query: string) => {
      exaCalls.push(query)
      return query.includes('retail')
        ? { output: { content: { found: true, price_low: 14499, price_high: 19999 } } }
        : { output: { content: { found: true, price_low: 8000, price_high: 11000 } } }
    },
  }
  const tavily: TavilyClient = {
    search: async (query: string) => {
      tavilyCalls.push(query)
      return { answer: 'No pricing information available.', results: [] }
    },
  }

  return { clients: { exa, tavily, ...overrides }, exaCalls, tavilyCalls }
}

const product: PriceLookupCandidate = {
  id: 2,
  base_model: 'Sony WH-1000XM4',
  variant_tier: null,
  description: 'A noise-cancelling headphone.',
  sibling_variants: [],
}

test('retail and secondhand (both via Exa) insert a price_history row each', async () => {
  const { clients } = fakeClients()
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  await runPriceLookup(clients, db, logger, [product])

  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toHaveLength(2)
  expect(inserts[0].params).toEqual([2, 14499, 19999, 'PHP', expect.any(String), 'exa_new_retail', 'New', null, null, null])
  expect(inserts[1].params).toEqual([2, 8000, 11000, 'PHP', expect.any(String), 'exa_secondhand', 'Used', null, null, null])
})

test('secondhand falls back to Tavily when Exa finds nothing', async () => {
  const exa: ExaClient = { searchStructured: async () => ({ output: { content: { found: false } } }) }
  const tavily: TavilyClient = {
    search: async (query: string) =>
      query.includes('secondhand')
        ? { answer: 'Used units go for around ₱7,000 to ₱9,000.', results: [] }
        : { answer: 'Retail price is ₱14,499 to ₱19,999.', results: [] },
  }
  const { clients } = fakeClients({ exa, tavily })
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  await runPriceLookup(clients, db, logger, [product])

  const secondhandInsert = calls.find((c) => c.sql.startsWith('INSERT INTO product_price_history') && c.params[6] === 'Used')
  expect(secondhandInsert?.params).toEqual([2, 7000, 9000, 'PHP', expect.any(String), 'tavily_secondhand', 'Used', null, null, null])
})

test('retail falls back to Tavily when Exa finds nothing', async () => {
  const exa: ExaClient = { searchStructured: async () => ({ output: { content: { found: false } } }) }
  const tavily: TavilyClient = {
    search: async (query: string) =>
      query.includes('retail')
        ? { answer: 'Retail price is ₱14,499 to ₱19,999.', results: [] }
        : { answer: 'Used units go for around ₱7,000 to ₱9,000.', results: [] },
  }
  const { clients } = fakeClients({ exa, tavily })
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  await runPriceLookup(clients, db, logger, [product])

  const retailInsert = calls.find((c) => c.sql.startsWith('INSERT INTO product_price_history') && c.params[6] === 'New')
  expect(retailInsert?.params).toEqual([2, 14499, 19999, 'PHP', expect.any(String), 'tavily_new_retail', 'New', null, null, null])
})

test('an Exa error falls through to Tavily without throwing', async () => {
  const exa: ExaClient = {
    searchStructured: async () => {
      throw new Error('exa credits exhausted')
    },
  }
  const tavily: TavilyClient = { search: async () => ({ answer: 'Used units go for around ₱7,000 to ₱9,000.', results: [] }) }
  const { clients } = fakeClients({ exa, tavily })
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  await runPriceLookup(clients, db, logger, [product])

  const secondhandInsert = calls.find((c) => c.sql.startsWith('INSERT INTO product_price_history') && c.params[6] === 'Used')
  expect(secondhandInsert?.params[5]).toBe('tavily_secondhand')
})

test('flags the product excluded when neither retail nor secondhand find a price', async () => {
  const exa: ExaClient = { searchStructured: async () => ({ output: { content: { found: false } } }) }
  const { clients } = fakeClients({ exa })
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  await runPriceLookup(clients, db, logger, [product])

  expect(calls.some((c) => c.sql.startsWith('INSERT INTO product_price_history'))).toBe(false)
  const flagCall = calls.find((c) => c.sql.startsWith('UPDATE products SET price_lookup_excluded'))
  expect(flagCall?.params).toEqual(['price_not_found', 2])
})

test('a generic base_model is flagged and skipped before spending any call', async () => {
  const { clients, exaCalls, tavilyCalls } = fakeClients()
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const genericProduct: PriceLookupCandidate = { id: 5, base_model: 'Refrigerator', variant_tier: null, description: null, sibling_variants: [] }

  await runPriceLookup(clients, db, logger, [genericProduct])

  expect(exaCalls).toHaveLength(0)
  expect(tavilyCalls).toHaveLength(0)
  const flagCall = calls.find((c) => c.sql.startsWith('UPDATE products SET price_lookup_excluded'))
  expect(flagCall?.params).toEqual(['too_generic', 5])
})

test('a wide-spread Exa result is dropped and falls through to Tavily', async () => {
  const exa: ExaClient = {
    searchStructured: async (query: string) =>
      query.includes('retail')
        ? { output: { content: { found: true, price_low: 14499, price_high: 19999 } } }
        : { output: { content: { found: true, price_low: 1000, price_high: 20000 } } },
  }
  const tavily: TavilyClient = { search: async () => ({ answer: 'Used units go for around ₱9,000 to ₱10,500.', results: [] }) }
  const { clients } = fakeClients({ exa, tavily })
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  await runPriceLookup(clients, db, logger, [product])

  const secondhandInsert = calls.find((c) => c.sql.startsWith('INSERT INTO product_price_history') && c.params[6] === 'Used')
  expect(secondhandInsert?.params[5]).toBe('tavily_secondhand')
})
