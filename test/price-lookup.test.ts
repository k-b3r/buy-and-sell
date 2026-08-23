import { existsSync, rmSync, readFileSync } from 'node:fs'
import { getPriceLookupCandidates, runPriceLookup } from '../src/price-lookup'
import { createLogger } from '../src/logger'
import type { GeminiClient } from '../src/gemini'
import type { DbClient } from '../src/db'

const LOG_PATH = 'test/tmp-price-lookup.log'

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

test('getPriceLookupCandidates only selects products with at least 2 listings', async () => {
  const { db, calls } = fakeDb([
    { id: 1, base_model: 'RTX 3060', variant_tier: null },
    { id: 2, base_model: 'iPhone 13', variant_tier: 'Pro Max' },
  ])

  const result = await getPriceLookupCandidates(db)

  expect(calls[0].sql).toContain('HAVING count(l.id) >= 2')
  expect(result).toEqual([
    { id: 1, base_model: 'RTX 3060', variant_tier: null },
    { id: 2, base_model: 'iPhone 13', variant_tier: 'Pro Max' },
  ])
})

test('runPriceLookup inserts a price check per product and waits between calls', async () => {
  const gemini = fakeGemini((prompt) =>
    prompt.includes('RTX 3060') ? 'PRICE_RANGE: 10000-15000 PHP' : 'PRICE_RANGE: 40000-55000 PHP',
  )
  const logger = createLogger(LOG_PATH)
  const { db, calls } = fakeDb()
  const delays: number[] = []
  const fakeDelay = async (ms: number) => {
    delays.push(ms)
  }
  const products = [
    { id: 1, base_model: 'RTX 3060', variant_tier: null },
    { id: 2, base_model: 'iPhone 13', variant_tier: 'Pro Max' },
  ]

  await runPriceLookup(gemini, db, logger, products, { delayMs: 15000 }, fakeDelay)

  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toEqual([
    { sql: expect.any(String), params: [1, 10000, 15000, 'PHP', 'PRICE_RANGE: 10000-15000 PHP', 'gemini_grounding', null, null, null, null] },
    { sql: expect.any(String), params: [2, 40000, 55000, 'PHP', 'PRICE_RANGE: 40000-55000 PHP', 'gemini_grounding', null, null, null, null] },
  ])
  expect(delays).toEqual([15000]) // waits between the 2 calls, not before the first
})

function quotaError(): Error & { status: number } {
  const err = new Error('quota exceeded') as Error & { status: number }
  err.status = 429
  return err
}

test('on a quota error, waits with growing backoff and keeps retrying the same product instead of crashing or skipping', async () => {
  let attempts = 0
  const gemini: GeminiClient = {
    generateJson: async () => {
      throw new Error('not used by price lookup')
    },
    generateGroundedText: async () => {
      attempts += 1
      if (attempts < 4) throw quotaError()
      return 'PRICE_RANGE: 1000-2000 PHP'
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
  // longer than the last, distinct from the flat 15000ms inter-product delay
  expect(delays).toHaveLength(3)
  expect(delays[1]).toBeGreaterThan(delays[0])
  expect(delays[2]).toBeGreaterThan(delays[1])
  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toEqual([{ sql: expect.any(String), params: [1, 1000, 2000, 'PHP', 'PRICE_RANGE: 1000-2000 PHP', 'gemini_grounding', null, null, null, null] }])
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

test('skips a product when the grounded response has no parseable price range, without crashing the run', async () => {
  const gemini = fakeGemini(() => 'I could not find enough listings to determine a price range.')
  const logger = createLogger(LOG_PATH)
  const { db, calls } = fakeDb()
  const products = [{ id: 1, base_model: 'Obscure Item', variant_tier: null }]

  await runPriceLookup(gemini, db, logger, products, { delayMs: 0 }, async () => {})

  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toHaveLength(0)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[WARN]')
})
