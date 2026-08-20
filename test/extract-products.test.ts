import { existsSync, rmSync, readFileSync } from 'node:fs'
import { runProductExtraction } from '../src/extract-products'
import { createLogger } from '../src/logger'
import type { GeminiClient } from '../src/gemini'
import type { DbClient } from '../src/db'

const LOG_PATH = 'test/tmp-extract.log'
const OUT_PATH = 'test/tmp-extract.jsonl'

afterEach(() => {
  for (const p of [LOG_PATH, OUT_PATH]) if (existsSync(p)) rmSync(p)
})

function fakeGemini(response: unknown): GeminiClient {
  return { generateJson: async () => response }
}

function fakeDb(): DbClient {
  return fakeDbWithCalls().db
}

function fakeDbWithCalls(): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const products: { id: number; normalized: string; variantTier: string | null }[] = []
  const calls: { sql: string; params: unknown[] }[] = []
  let nextId = 1
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        if (sql.startsWith('SELECT')) {
          const [normalized, variantTier] = params as [string, string | null]
          const match = products.find((p) => p.normalized === normalized && p.variantTier === variantTier)
          return { rows: match ? [{ id: match.id }] : [] }
        }
        if (sql.startsWith('INSERT')) {
          const [, normalized, variantTier] = params as [string, string, string | null]
          const id = nextId++
          products.push({ id, normalized, variantTier })
          return { rows: [{ id }] }
        }
        return { rows: [] } // UPDATE listings ...
      },
    },
  }
}

test('assigns product_id to each listing from the batched Gemini response', async () => {
  const gemini = fakeGemini([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'iPhone 13' },
  ])
  const logger = createLogger(LOG_PATH)
  const listings = [
    { id: '1', marketplace_listing_title: 'RTX 3060 for sale' },
    { id: '2', marketplace_listing_title: 'iPhone 13 rush' },
  ]

  const result = await runProductExtraction(gemini, fakeDb(), logger, listings, { batchSize: 25, outputPath: OUT_PATH })

  expect(result[0].product_id).toBe(1)
  expect(result[1].product_id).toBe(2)
})

test('two listings with the same base_model get the same product_id', async () => {
  const gemini = fakeGemini([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'RTX 3060' },
  ])
  const logger = createLogger(LOG_PATH)
  const listings = [
    { id: '1', marketplace_listing_title: 'RTX 3060 for sale' },
    { id: '2', marketplace_listing_title: 'RTX 3060 OC' },
  ]

  const result = await runProductExtraction(gemini, fakeDb(), logger, listings, { batchSize: 25, outputPath: OUT_PATH })

  expect(result[0].product_id).toBe(result[1].product_id)
})

test('listings that already have a product_id are excluded from the batch sent to Gemini', async () => {
  let promptedIds: string[] = []
  const gemini: GeminiClient = {
    generateJson: async (prompt: string) => {
      promptedIds = [...prompt.matchAll(/\[id: (\S+)\]/g)].map((m) => m[1])
      return [{ id: '2', base_model: 'iPhone 13' }]
    },
  }
  const logger = createLogger(LOG_PATH)
  const listings = [
    { id: '1', marketplace_listing_title: 'Already done', product_id: 99 },
    { id: '2', marketplace_listing_title: 'iPhone 13 rush' },
  ]

  await runProductExtraction(gemini, fakeDb(), logger, listings, { batchSize: 25, outputPath: OUT_PATH })

  expect(promptedIds).toEqual(['2'])
})

test('batches all product_id assignments from one Gemini batch into a single UPDATE call', async () => {
  const gemini = fakeGemini([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'iPhone 13' },
  ])
  const logger = createLogger(LOG_PATH)
  const listings = [
    { id: '1', marketplace_listing_title: 'RTX 3060 for sale' },
    { id: '2', marketplace_listing_title: 'iPhone 13 rush' },
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(gemini, db, logger, listings, { batchSize: 25, outputPath: OUT_PATH })

  const updateCalls = calls.filter((c) => c.sql.startsWith('UPDATE listings'))
  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0].sql).toContain('FROM (VALUES')
  expect(updateCalls[0].params).toEqual(['1', 1, '2', 2])
})

test('resolves each distinct base_model only once per run, even across multiple listings', async () => {
  const gemini = fakeGemini([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'RTX 3060' },
    { id: '3', base_model: 'iPhone 13' },
  ])
  const logger = createLogger(LOG_PATH)
  const listings = [
    { id: '1', marketplace_listing_title: 'RTX 3060' },
    { id: '2', marketplace_listing_title: 'RTX 3060 OC' },
    { id: '3', marketplace_listing_title: 'iPhone 13' },
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(gemini, db, logger, listings, { batchSize: 25, outputPath: OUT_PATH })

  // 2 distinct base models, each a SELECT (miss) + INSERT = 4 total product-lookup
  // calls — not 5+, which is what re-resolving the repeated "RTX 3060" would cost.
  const productLookupCalls = calls.filter((c) => c.sql.startsWith('SELECT') || c.sql.startsWith('INSERT'))
  expect(productLookupCalls).toHaveLength(4)
})

test('a malformed batch response is logged and skipped, without crashing the run', async () => {
  const gemini = fakeGemini({ not: 'an array' })
  const logger = createLogger(LOG_PATH)
  const listings = [{ id: '1', marketplace_listing_title: 'RTX 3060' }]

  const result = await runProductExtraction(gemini, fakeDb(), logger, listings, { batchSize: 25, outputPath: OUT_PATH })

  expect(result[0].product_id).toBeUndefined()
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[ERROR]')
})
