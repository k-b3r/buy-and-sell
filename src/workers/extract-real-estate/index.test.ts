import { existsSync, rmSync } from 'node:fs'
import { extractRealEstateBatch, runRealEstateExtraction } from './index'
import { createLogger } from '../../platform/logger'
import type { GroqClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { RealEstateCandidate } from '../../domains/marketplace'

const LOG_PATH = 'data/tmp-extract-real-estate.log'
afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

const noDelay = async () => {}
const cand = (id: string, over: Partial<RealEstateCandidate> = {}): RealEstateCandidate => ({
  id,
  title: 'Condo for sale Makati',
  description: null,
  price_amount: 4500000,
  source_hash: `hash-${id}`,
  ...over,
})
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  listing_type: 'sale',
  property_type: 'condo',
  price_php: 4500000,
  price_basis: 'total',
  lot_sqm: null,
  floor_sqm: 35,
  bedrooms: 1,
  bathrooms: 1,
  project_name: null,
  area_text: 'Makati',
  tags: [],
  confidence: 'high',
  ...over,
})

test('extractRealEstateBatch returns normalized fields keyed by listing id and skips unknown ids', async () => {
  const groq: GroqClient = { generateJson: async () => ({ results: [item('1'), item('zzz')] }) }
  const out = await extractRealEstateBatch(groq, createLogger(LOG_PATH), noDelay, [cand('1')])
  expect([...out.keys()]).toEqual(['1'])
  expect(out.get('1')).toMatchObject({ property_type: 'condo', price_php: 4500000 })
})

test('extractRealEstateBatch splits the batch and retries when a request keeps failing', async () => {
  let calls = 0
  const groq: GroqClient = {
    generateJson: async (prompt: string) => {
      calls++
      const ids = [...prompt.matchAll(/"id":"(\w+)"/g)].map((m) => m[1])
      if (ids.length > 1) throw Object.assign(new Error('bad shape'), { status: 400 })
      return { results: ids.map((id) => item(id)) }
    },
  }
  const out = await extractRealEstateBatch(groq, createLogger(LOG_PATH), noDelay, [cand('1'), cand('2')])
  expect([...out.keys()].sort()).toEqual(['1', '2'])
  expect(calls).toBeGreaterThan(2)
})

test('extractRealEstateBatch stops the run on a 429 quota error', async () => {
  const groq: GroqClient = {
    generateJson: async () => {
      throw Object.assign(new Error('quota'), { status: 429 })
    },
  }
  await expect(extractRealEstateBatch(groq, createLogger(LOG_PATH), noDelay, [cand('1')])).rejects.toThrow()
})

test('runRealEstateExtraction upserts each extracted listing with its source hash', async () => {
  const params: unknown[][] = []
  const db: DbClient = {
    query: async (_sql: string, p: unknown[]) => {
      params.push(p)
      return { rows: [] }
    },
  }
  const groq: GroqClient = { generateJson: async () => ({ results: [item('1')]}) }

  await runRealEstateExtraction(groq, db, createLogger(LOG_PATH), [cand('1')], 20, noDelay)

  expect(params).toHaveLength(1)
  expect(params[0][0]).toBe('1')
  expect(params[0][13]).toBe('hash-1')
  expect(params[0][14]).toBe('openai/gpt-oss-120b')
})

test('extractRealEstateBatch retries the listings the model left out of its response', async () => {
  let calls = 0
  const groq: GroqClient = {
    generateJson: async (prompt: string) => {
      calls++
      const ids = [...prompt.matchAll(/"id":"(\w+)"/g)].map((m) => m[1])
      // The model drops the back half of whatever it is given.
      return { results: ids.slice(0, Math.ceil(ids.length / 2)).map((id) => item(id)) }
    },
  }
  const out = await extractRealEstateBatch(groq, createLogger(LOG_PATH), noDelay, [cand('1'), cand('2'), cand('3')])
  expect([...out.keys()].sort()).toEqual(['1', '2', '3'])
  expect(calls).toBe(2)
})

test('extractRealEstateBatch retries missing listings only once, so a stubborn model cannot loop', async () => {
  let calls = 0
  const groq: GroqClient = {
    generateJson: async () => {
      calls++
      return { results: [] }
    },
  }
  const out = await extractRealEstateBatch(groq, createLogger(LOG_PATH), noDelay, [cand('1'), cand('2')])
  expect(out.size).toBe(0)
  expect(calls).toBe(2)
})
