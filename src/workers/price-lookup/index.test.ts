import { existsSync, rmSync, readFileSync } from 'node:fs'
import { runPriceLookup } from './index'
import { createLogger } from '../../logger'
import type { GeminiClient } from '../../gemini'
import type { DbClient } from '../../storage/client'

const LOG_PATH = 'data/tmp-price-lookup.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function fakeGemini(byPrompt: (prompt: string) => string): GeminiClient {
  return {
    generateJson: async () => {
      throw new Error('not used by price lookup')
    },
    generateGroundedText: async (prompt: string) => byPrompt(prompt),
  }
}

function jsonBlock(results: { id: string; found: boolean; price_low?: number; price_high?: number; currency?: string }[]): string {
  return '```json\n' + JSON.stringify(results) + '\n```'
}

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

test('runPriceLookup batches up to 5 products per call and inserts a price check per found product', async () => {
  const gemini = fakeGemini(() =>
    jsonBlock([
      { id: '1', found: true, price_low: 10000, price_high: 15000, currency: 'PHP' },
      { id: '2', found: true, price_low: 40000, price_high: 55000, currency: 'PHP' },
    ]),
  )
  const logger = createLogger(LOG_PATH)
  const { db, calls } = fakeDb()
  const products = [
    { id: 1, base_model: 'RTX 3060', variant_tier: null },
    { id: 2, base_model: 'iPhone 13', variant_tier: 'Pro Max' },
  ]

  await runPriceLookup(gemini, db, logger, products, { delayMs: 15000 }, async () => {})

  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toHaveLength(2)
  expect(inserts[0].params).toEqual([1, 10000, 15000, 'PHP', expect.any(String), 'gemini_grounding', null, null, null, null])
  expect(inserts[1].params).toEqual([2, 40000, 55000, 'PHP', expect.any(String), 'gemini_grounding', null, null, null, null])
})

test('one call covers a full batch of 5 - no per-product calls within a batch', async () => {
  let callCount = 0
  const gemini: GeminiClient = {
    generateJson: async () => {
      throw new Error('not used by price lookup')
    },
    generateGroundedText: async () => {
      callCount += 1
      return jsonBlock([1, 2, 3, 4, 5].map((id) => ({ id: String(id), found: true, price_low: 100, price_high: 200, currency: 'PHP' })))
    },
  }
  const logger = createLogger(LOG_PATH)
  const { db } = fakeDb()
  const products = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, base_model: `Product ${i + 1}`, variant_tier: null }))

  await runPriceLookup(gemini, db, logger, products, { delayMs: 0 }, async () => {})

  expect(callCount).toBe(1)
})

test('waits between batches but not before the first one', async () => {
  let callCount = 0
  const gemini: GeminiClient = {
    generateJson: async () => {
      throw new Error('not used by price lookup')
    },
    generateGroundedText: async () => {
      callCount += 1
      return jsonBlock([])
    },
  }
  const logger = createLogger(LOG_PATH)
  const { db } = fakeDb()
  const products = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, base_model: `Product ${i + 1}`, variant_tier: null }))
  const delays: number[] = []

  await runPriceLookup(gemini, db, logger, products, { delayMs: 15000 }, async (ms) => {
    delays.push(ms)
  })

  // 7 products / batch size 5 -> 2 batches -> 1 wait between them
  expect(callCount).toBe(2)
  expect(delays).toEqual([15000])
})

function quotaError(): Error & { status: number } {
  const err = new Error('quota exceeded') as Error & { status: number }
  err.status = 429
  return err
}

test('on a quota error, waits with growing backoff and keeps retrying the same batch instead of crashing or skipping', async () => {
  let attempts = 0
  const gemini: GeminiClient = {
    generateJson: async () => {
      throw new Error('not used by price lookup')
    },
    generateGroundedText: async () => {
      attempts += 1
      if (attempts < 4) throw quotaError()
      return jsonBlock([{ id: '1', found: true, price_low: 1000, price_high: 2000, currency: 'PHP' }])
    },
  }
  const logger = createLogger(LOG_PATH)
  const { db, calls } = fakeDb()
  const delays: number[] = []
  const fakeDelay = async (ms: number) => {
    delays.push(ms)
  }
  const products = [{ id: 1, base_model: 'RTX 3060', variant_tier: null }]

  await runPriceLookup(gemini, db, logger, products, { delayMs: 15000 }, fakeDelay)

  expect(attempts).toBe(4)
  // 3 backoff waits (one per failed attempt) before the eventual success, each
  // longer than the last, distinct from the flat 15000ms inter-batch delay
  expect(delays).toHaveLength(3)
  expect(delays[0]).toBe(600000) // 10 min
  expect(delays[1]).toBe(1200000) // 20 min
  expect(delays[2]).toBe(2400000) // 40 min
  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toEqual([
    { sql: expect.any(String), params: [1, 1000, 2000, 'PHP', expect.any(String), 'gemini_grounding', null, null, null, null] },
  ])
})

test('backoff caps at 1 hour', async () => {
  let attempts = 0
  const gemini: GeminiClient = {
    generateJson: async () => {
      throw new Error('not used by price lookup')
    },
    generateGroundedText: async () => {
      attempts += 1
      if (attempts < 6) throw quotaError()
      return jsonBlock([{ id: '1', found: true, price_low: 1000, price_high: 2000, currency: 'PHP' }])
    },
  }
  const logger = createLogger(LOG_PATH)
  const { db } = fakeDb()
  const delays: number[] = []
  const products = [{ id: 1, base_model: 'RTX 3060', variant_tier: null }]

  await runPriceLookup(gemini, db, logger, products, { delayMs: 0 }, async (ms) => {
    delays.push(ms)
  })

  // 10, 20, 40, 60 (capped), 60 (capped)
  expect(delays).toEqual([600000, 1200000, 2400000, 3600000, 3600000])
})

test('a non-quota error still fails closed immediately, no retry loop', async () => {
  let attempts = 0
  const gemini: GeminiClient = {
    generateJson: async () => {
      throw new Error('not used by price lookup')
    },
    generateGroundedText: async () => {
      attempts += 1
      throw new Error('some real bug, not a quota issue')
    },
  }
  const logger = createLogger(LOG_PATH)
  const { db } = fakeDb()
  const products = [{ id: 1, base_model: 'RTX 3060', variant_tier: null }]

  await expect(
    runPriceLookup(gemini, db, logger, products, { delayMs: 0 }, async () => {}),
  ).rejects.toThrow('some real bug, not a quota issue')
  expect(attempts).toBe(1)
})

test('skips a product the response marks as not found, without crashing the run', async () => {
  const gemini = fakeGemini(() => jsonBlock([{ id: '1', found: false }]))
  const logger = createLogger(LOG_PATH)
  const { db, calls } = fakeDb()
  const products = [{ id: 1, base_model: 'Obscure Item', variant_tier: null }]

  await runPriceLookup(gemini, db, logger, products, { delayMs: 0 }, async () => {})

  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toHaveLength(0)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[WARN]')
})

test('a batch response with no parseable json block is logged and skipped, without crashing the run', async () => {
  const gemini = fakeGemini(() => 'I could not find enough listings to determine a price range.')
  const logger = createLogger(LOG_PATH)
  const { db, calls } = fakeDb()
  const products = [{ id: 1, base_model: 'Obscure Item', variant_tier: null }]

  await runPriceLookup(gemini, db, logger, products, { delayMs: 0 }, async () => {})

  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toHaveLength(0)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[ERROR]')
})
