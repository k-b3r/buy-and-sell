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
  const products: { id: number; normalized: string; variantTier: string | null }[] = []
  let nextId = 1
  return {
    query: async (sql: string, params: unknown[]) => {
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

test('a malformed batch response is logged and skipped, without crashing the run', async () => {
  const gemini = fakeGemini({ not: 'an array' })
  const logger = createLogger(LOG_PATH)
  const listings = [{ id: '1', marketplace_listing_title: 'RTX 3060' }]

  const result = await runProductExtraction(gemini, fakeDb(), logger, listings, { batchSize: 25, outputPath: OUT_PATH })

  expect(result[0].product_id).toBeUndefined()
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[ERROR]')
})
