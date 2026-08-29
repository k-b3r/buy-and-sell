import { existsSync, rmSync, readFileSync } from 'node:fs'
import { runClaudePriceLookup } from './index'
import { createLogger } from '../../platform/logger'
import type { AnthropicClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { ClaudePriceCandidate } from '../../domains/marketplace'

const LOG_PATH = 'data/tmp-claude-price-lookup.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function textResponse(content: unknown): unknown {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(content) }] }
}

function fakeAnthropic(response: unknown): { anthropic: AnthropicClient; calls: { query: string; systemPrompt: string }[] } {
  const calls: { query: string; systemPrompt: string }[] = []
  return {
    calls,
    anthropic: {
      searchStructured: async (query: string, systemPrompt: string) => {
        calls.push({ query, systemPrompt })
        return response
      },
    },
  }
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

test('builds the system prompt with product context before calling Claude', async () => {
  const response = textResponse({
    retail: { found: true, price_low: 14499, price_high: 19999 },
    secondhand: { found: true, price_low: 8000, price_high: 11000 },
  })
  const { anthropic, calls } = fakeAnthropic(response)
  const { db } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: ClaudePriceCandidate[] = [
    { id: 2, base_model: 'Sony WH-1000XM4', variant_tier: null, description: 'A noise-cancelling headphone.', sibling_variants: [] },
  ]

  await runClaudePriceLookup(anthropic, db, logger, products)

  expect(calls[0].systemPrompt).toContain('Product context: A noise-cancelling headphone.')
})

test('insert params match insertPriceCheck shape for both sides', async () => {
  const response = textResponse({
    retail: { found: true, price_low: 14499, price_high: 19999 },
    secondhand: { found: true, price_low: 8000, price_high: 11000 },
  })
  const { anthropic } = fakeAnthropic(response)
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: ClaudePriceCandidate[] = [
    { id: 2, base_model: 'Sony WH-1000XM4', variant_tier: null, description: null, sibling_variants: [] },
  ]

  await runClaudePriceLookup(anthropic, db, logger, products)

  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toHaveLength(2)
  expect(inserts[0].params).toEqual([2, 14499, 19999, 'PHP', JSON.stringify(response), 'web_search', 'New', null, null, null])
  expect(inserts[1].params).toEqual([2, 8000, 11000, 'PHP', JSON.stringify(response), 'web_search', 'Used', null, null, null])
})

test('only inserts the side that was found when the other side is not found', async () => {
  const response = textResponse({
    retail: { found: false },
    secondhand: { found: true, price_low: 8000, price_high: 11000 },
  })
  const { anthropic } = fakeAnthropic(response)
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: ClaudePriceCandidate[] = [{ id: 3, base_model: 'Old Gadget', variant_tier: null, description: null, sibling_variants: [] }]

  await runClaudePriceLookup(anthropic, db, logger, products)

  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toHaveLength(1)
  expect(inserts[0].params).toEqual([3, 8000, 11000, 'PHP', JSON.stringify(response), 'web_search', 'Used', null, null, null])
})

test('a too-wide range on one side is dropped, the other side (if usable) still inserts', async () => {
  const response = textResponse({
    retail: { found: true, price_low: 4895, price_high: 58140 },
    secondhand: { found: true, price_low: 8000, price_high: 11000 },
  })
  const { anthropic } = fakeAnthropic(response)
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: ClaudePriceCandidate[] = [{ id: 12, base_model: 'Weird Product 900', variant_tier: null, description: null, sibling_variants: [] }]

  await runClaudePriceLookup(anthropic, db, logger, products)

  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toHaveLength(1)
  expect(inserts[0].params[6]).toBe('Used')
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('retail price range too wide')
})

test('neither side usable: flagged price_lookup_excluded, no price_history row inserted', async () => {
  const response = textResponse({ retail: { found: false }, secondhand: { found: false } })
  const { anthropic } = fakeAnthropic(response)
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: ClaudePriceCandidate[] = [{ id: 5, base_model: 'Obscure Widget 3000', variant_tier: null, description: null, sibling_variants: [] }]

  await runClaudePriceLookup(anthropic, db, logger, products)

  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  const flags = calls.filter((c) => c.sql.startsWith('UPDATE products SET price_lookup_excluded'))
  expect(inserts).toHaveLength(0)
  expect(flags).toEqual([{ sql: expect.any(String), params: ['claude_no_result', 5] }])
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[WARN]')
})

test('a detected-generic product is flagged and skipped without spending a Claude call on it', async () => {
  const { anthropic, calls } = fakeAnthropic(textResponse({ retail: { found: true, price_low: 100, price_high: 200 }, secondhand: { found: false } }))
  const { db, calls: dbCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: ClaudePriceCandidate[] = [{ id: 3, base_model: 'Air Conditioner', variant_tier: null, description: null, sibling_variants: [] }]

  await runClaudePriceLookup(anthropic, db, logger, products)

  expect(calls).toHaveLength(0)
  const flags = dbCalls.filter((c) => c.sql.startsWith('UPDATE products SET price_lookup_excluded'))
  expect(flags).toEqual([{ sql: expect.any(String), params: ['too_generic', 3] }])
})

test('a Claude request failure for one product is logged and does not stop the run', async () => {
  let call = 0
  const anthropic: AnthropicClient = {
    searchStructured: async () => {
      call += 1
      if (call === 1) throw new Error('network blip')
      return textResponse({ retail: { found: true, price_low: 100, price_high: 200 }, secondhand: { found: false } })
    },
  }
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: ClaudePriceCandidate[] = [
    { id: 1, base_model: 'A', variant_tier: null, description: null, sibling_variants: [] },
    { id: 2, base_model: 'B', variant_tier: null, description: null, sibling_variants: [] },
  ]

  await runClaudePriceLookup(anthropic, db, logger, products, async () => {})

  expect(call).toBe(2)
  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toHaveLength(1)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[ERROR]')
})

test('a refusal response is treated as no result found for both sides', async () => {
  const { anthropic } = fakeAnthropic({ stop_reason: 'refusal', content: [] })
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: ClaudePriceCandidate[] = [{ id: 7, base_model: 'Rare Item', variant_tier: null, description: null, sibling_variants: [] }]

  await runClaudePriceLookup(anthropic, db, logger, products)

  const flags = calls.filter((c) => c.sql.startsWith('UPDATE products SET price_lookup_excluded'))
  expect(flags).toEqual([{ sql: expect.any(String), params: ['claude_no_result', 7] }])
})
