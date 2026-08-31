import { existsSync, rmSync } from 'node:fs'
import { runPriceLookup } from './index'
import type { PriceLookupClients } from './index'
import { createLogger } from '../../platform/logger'
import type { GeminiClient, ExaClient, TavilyClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { PriceLookupCandidate } from '../../domains/marketplace'

const LOG_PATH = 'data/tmp-price-lookup.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

// runPriceLookup is a thin loop now - all provider-chain/exclusion behavior
// is tested directly against ensureProductPriced in
// domains/marketplace/price-lookup.test.ts. These tests just confirm the
// loop calls it once per product, with the right pacing.
function fakeClients(): PriceLookupClients {
  const gemini: GeminiClient = { generateJson: async () => ({}), generateGroundedText: async () => '```json\n{"found": false}\n```' }
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

  await runPriceLookup(clients, db, logger, products, async () => {})

  const flagCalls = calls.filter((c) => c.sql.startsWith('UPDATE products SET price_lookup_excluded'))
  expect(flagCalls.map((c) => c.params[1])).toEqual([1, 2])
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

  await runPriceLookup(clients, db, logger, products, async (ms) => {
    delays.push(ms)
  })

  expect(delays).toEqual([1000, 1000])
})
