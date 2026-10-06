import { existsSync, rmSync } from 'node:fs'
import { runPriceLookup } from './run-price-lookup'
import type { PriceLookupCandidate, PriceLookupClients } from './price-lookup'
import { createLogger } from '../../platform/logger'
import type { Logger } from '../../platform/logger'
import type { GeminiClient, ExaClient, TavilyClient } from '../../platform/llm-clients'
import { QuotaExhaustedError } from '../../platform/llm-clients'
import type { DbClient } from '../../platform/storage'

const LOG_PATH = 'data/tmp-price-lookup.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

// runPriceLookup is a thin loop now - all provider-chain/exclusion behavior
// is tested directly against ensureProductPriced in
// price-lookup.test.ts. These tests just confirm the
// loop calls it once per product, with the right pacing.
function fakeClients(): PriceLookupClients {
  const gemini: GeminiClient = {
    generateJson: async () => ({}),
    generateGroundedText: async () => '```json\n{"found": false}\n```',
  }
  const exa: ExaClient = { searchStructured: async () => ({ output: { content: { found: false } } }) }
  const tavily: TavilyClient = { search: async () => ({ answer: null, results: [] }) }
  return { gemini, exa, tavily }
}

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

test('processes every product given, one at a time', async () => {
  const clients = fakeClients()
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: PriceLookupCandidate[] = [
    { id: 1, base_model: 'Sony WH-1000XM4', variant_tier: null, description: null, sibling_variants: [] },
    { id: 2, base_model: 'RTX 3060', variant_tier: null, description: null, sibling_variants: [] },
  ]

  await runPriceLookup({ clients, db, logger, delay: async () => {} }, products)

  const flagCalls = calls.filter((c) => c.sql.startsWith('UPDATE products SET price_lookup_excluded'))
  expect(flagCalls.map((c) => c.params[1])).toEqual([1, 2])
})

function recordingLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = []
  return {
    errors,
    logger: { info: () => {}, warn: () => {}, error: (msg) => errors.push(msg) },
  }
}

const TWO_PRODUCTS: PriceLookupCandidate[] = [
  { id: 1, base_model: 'Sony WH-1000XM4', variant_tier: null, description: null, sibling_variants: [] },
  { id: 2, base_model: 'RTX 3060', variant_tier: null, description: null, sibling_variants: [] },
]

test('a product that throws is logged with its id and the lap moves on to the next product', async () => {
  const pricedIds: unknown[] = []
  const db: DbClient = {
    query: async (sql: string, params: unknown[]) => {
      if (params[1] === 1) throw new Error('connection reset')
      if (sql.startsWith('UPDATE products SET price_lookup_excluded')) pricedIds.push(params[1])
      return { rows: [] }
    },
  }
  const { logger, errors } = recordingLogger()

  await runPriceLookup({ clients: fakeClients(), db, logger, delay: async () => {} }, TWO_PRODUCTS)

  expect(pricedIds).toEqual([2])
  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain('product 1')
  expect(errors[0]).toContain('connection reset')
})

test('a quota exhaustion unwinds the lap instead of moving on', async () => {
  const queriedIds: unknown[] = []
  const db: DbClient = {
    query: async (_sql: string, params: unknown[]) => {
      queriedIds.push(params[1])
      throw new QuotaExhaustedError('daily budget gone')
    },
  }
  const { logger } = recordingLogger()

  await expect(
    runPriceLookup({ clients: fakeClients(), db, logger, delay: async () => {} }, TWO_PRODUCTS),
  ).rejects.toBeInstanceOf(QuotaExhaustedError)
  expect(queriedIds).toEqual([1])
})

test('waits between products but not before the first one', async () => {
  const clients = fakeClients()
  const { db } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: PriceLookupCandidate[] = [
    { id: 1, base_model: 'A', variant_tier: null, description: null, sibling_variants: [] },
    { id: 2, base_model: 'B', variant_tier: null, description: null, sibling_variants: [] },
    { id: 3, base_model: 'C', variant_tier: null, description: null, sibling_variants: [] },
  ]
  const delays: number[] = []

  await runPriceLookup(
    {
      clients,
      db,
      logger,
      delay: async (ms) => {
        delays.push(ms)
      },
    },
    products,
  )

  expect(delays).toEqual([1000, 1000])
})
