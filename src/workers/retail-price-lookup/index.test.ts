import { existsSync, rmSync, readFileSync } from 'node:fs'
import { runNewPriceLookup } from './index'
import { createLogger } from '../../platform/logger'
import type { ExaClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { NewPriceCandidate } from '../../new-price'

const LOG_PATH = 'data/tmp-new-price.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function fakeExa(content: unknown): { exa: ExaClient; calls: { query: string; systemPrompt: string }[] } {
  const calls: { query: string; systemPrompt: string }[] = []
  return {
    calls,
    exa: {
      searchStructured: async (query: string, systemPrompt: string) => {
        calls.push({ query, systemPrompt })
        return content
      },
    },
  }
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

test('inserts a price_history row (with confidence) per product when a real price is found', async () => {
  const response = {
    output: {
      content: { found: true, price_low: 14499, price_high: 19999 },
      grounding: [
        { field: 'price_low', confidence: 'high' },
        { field: 'price_high', confidence: 'high' },
      ],
    },
  }
  const { exa, calls } = fakeExa(response)
  const { db, inserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: NewPriceCandidate[] = [
    { id: 2, base_model: 'Sony WH-1000XM4', variant_tier: null, description: 'A noise-cancelling headphone.', sibling_variants: [] },
  ]

  await runNewPriceLookup(exa, db, logger, products)

  expect(inserts).toHaveLength(1)
  expect(inserts[0]).toEqual([2, 14499, 19999, 'PHP', JSON.stringify(response), 'exa_new_retail', 'New', 'high', null, null])
  expect(calls[0].systemPrompt).toContain('Product context: A noise-cancelling headphone.')
})

test('inserts release_year and is_discontinued when Exa returns them', async () => {
  const response = {
    output: {
      content: { found: true, price_low: 14499, price_high: 19999, release_year: 2021, is_discontinued: true },
      grounding: [
        { field: 'price_low', confidence: 'high' },
        { field: 'price_high', confidence: 'high' },
      ],
    },
  }
  const { exa } = fakeExa(response)
  const { db, inserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: NewPriceCandidate[] = [
    { id: 2, base_model: 'Sony WH-1000XM4', variant_tier: null, description: null, sibling_variants: [] },
  ]

  await runNewPriceLookup(exa, db, logger, products)

  expect(inserts[0]).toEqual([2, 14499, 19999, 'PHP', JSON.stringify(response), 'exa_new_retail', 'New', 'high', 2021, true])
})

test('a too-wide price range is not inserted — flagged price_lookup_excluded, checked before confidence', async () => {
  const response = {
    output: {
      content: { found: true, price_low: 4895, price_high: 58140 },
      grounding: [
        { field: 'price_low', confidence: 'high' },
        { field: 'price_high', confidence: 'high' },
      ],
    },
  }
  const { exa } = fakeExa(response)
  const { db, inserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: NewPriceCandidate[] = [
    { id: 12, base_model: 'CPU Motherboard Bundle', variant_tier: null, description: null, sibling_variants: [] },
  ]

  await runNewPriceLookup(exa, db, logger, products)

  expect(inserts).toHaveLength(1)
  expect(inserts[0]).toEqual(['exa_wide_spread', 12])
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[WARN]')
})

test('a low-confidence price is not inserted — flagged price_lookup_excluded with a distinct reason instead of trusted', async () => {
  const response = {
    output: {
      content: { found: true, price_low: 5000, price_high: 8000 },
      grounding: [
        { field: 'price_low', confidence: 'high' },
        { field: 'price_high', confidence: 'low' },
      ],
    },
  }
  const { exa } = fakeExa(response)
  const { db, inserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: NewPriceCandidate[] = [
    { id: 9, base_model: 'Sketchy Gadget', variant_tier: null, description: null, sibling_variants: [] },
  ]

  await runNewPriceLookup(exa, db, logger, products)

  expect(inserts).toHaveLength(1)
  expect(inserts[0]).toEqual(['exa_low_confidence', 9])
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[WARN]')
})

test('a product with no reliable price found is logged, flagged price_lookup_excluded, and skipped, no price_history row inserted', async () => {
  const { exa } = fakeExa({ output: { content: { found: false } } })
  const { db, inserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: NewPriceCandidate[] = [
    { id: 5, base_model: 'Obscure Widget', variant_tier: null, description: null, sibling_variants: [] },
  ]

  await runNewPriceLookup(exa, db, logger, products)

  expect(inserts).toHaveLength(1)
  expect(inserts[0]).toEqual(['exa_no_result', 5])
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[WARN]')
})

test('an Exa request failure for one product is logged and does not stop the run', async () => {
  let call = 0
  const exa: ExaClient = {
    searchStructured: async () => {
      call += 1
      if (call === 1) throw new Error('network blip')
      return { output: { content: { found: true, price_low: 100, price_high: 200 } } }
    },
  }
  const { db, inserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const products: NewPriceCandidate[] = [
    { id: 1, base_model: 'A', variant_tier: null, description: null, sibling_variants: [] },
    { id: 2, base_model: 'B', variant_tier: null, description: null, sibling_variants: [] },
  ]

  await runNewPriceLookup(exa, db, logger, products, async () => {})

  expect(call).toBe(2)
  expect(inserts).toHaveLength(1)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[ERROR]')
})
