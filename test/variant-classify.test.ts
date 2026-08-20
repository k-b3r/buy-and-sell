import { existsSync, rmSync } from 'node:fs'
import { runVariantClassification } from '../src/variant-classify'
import { createLogger } from '../src/logger'
import type { GeminiClient } from '../src/gemini'
import type { DbClient } from '../src/db'

const LOG_PATH = 'test/tmp-variant.log'
const OUT_PATH = 'test/tmp-variant.jsonl'

afterEach(() => {
  for (const p of [LOG_PATH, OUT_PATH]) if (existsSync(p)) rmSync(p)
})

function fakeDb(startId: number): DbClient {
  const products: { id: number; normalized: string; variantTier: string | null }[] = []
  let nextId = startId
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
      return { rows: [] }
    },
  }
}

test('reassigns each targeted listing to a new product_id split by variant_tier', async () => {
  const gemini: GeminiClient = {
    generateJson: async () => [
      { id: '1', variant_tier: 'Custom AIB/OC' },
      { id: '2', variant_tier: 'Reference/Founders Edition' },
    ],
  }
  const logger = createLogger(LOG_PATH)
  const listings = [
    { id: '1', marketplace_listing_title: 'RTX 3060 OC Asus', product_id: 5 },
    { id: '2', marketplace_listing_title: 'RTX 3060 Founders Edition', product_id: 5 },
    { id: '3', marketplace_listing_title: 'Unrelated listing', product_id: 6 },
  ]

  const result = await runVariantClassification(
    gemini,
    fakeDb(100),
    logger,
    listings,
    'RTX 3060',
    ['Reference/Founders Edition', 'Custom AIB/OC'],
    5,
    { outputPath: OUT_PATH },
  )

  expect(result[0].product_id).not.toBe(5)
  expect(result[1].product_id).not.toBe(5)
  expect(result[0].product_id).not.toBe(result[1].product_id) // different variant tiers -> different products
  expect(result[2].product_id).toBe(6) // untouched, wasn't part of this product
})

test('only sends listings belonging to the target product_id to Gemini', async () => {
  let promptedIds: string[] = []
  const gemini: GeminiClient = {
    generateJson: async (prompt: string) => {
      promptedIds = [...prompt.matchAll(/\[id: (\S+)\]/g)].map((m) => m[1])
      return [{ id: '1', variant_tier: 'Unknown' }]
    },
  }
  const logger = createLogger(LOG_PATH)
  const listings = [
    { id: '1', marketplace_listing_title: 'RTX 3060', product_id: 5 },
    { id: '2', marketplace_listing_title: 'Something else', product_id: 6 },
  ]

  await runVariantClassification(gemini, fakeDb(100), logger, listings, 'RTX 3060', ['Unknown'], 5, {
    outputPath: OUT_PATH,
  })

  expect(promptedIds).toEqual(['1'])
})
