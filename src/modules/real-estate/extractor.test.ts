import { existsSync, rmSync } from 'node:fs'
import { extractRealEstateBatch, EXTRACTOR_MODELS, EXTRACTOR_REQUEST_OPTIONS } from './extractor'
import type { JsonModelClient } from './types'
import { createLogger } from '../../platform/logger'
import type { RealEstateCandidate } from './types'

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
  const groq: JsonModelClient = { generateJson: async () => ({ results: [item('1'), item('zzz')] }) }
  const out = await extractRealEstateBatch({ groq, logger: createLogger(LOG_PATH), delay: noDelay }, [cand('1')])
  expect([...out.keys()]).toEqual(['1'])
  expect(out.get('1')).toMatchObject({ property_type: 'condo', price_php: 4500000 })
})

test('extractRealEstateBatch splits the batch and retries when a request keeps failing', async () => {
  let calls = 0
  const groq: JsonModelClient = {
    generateJson: async (prompt: string) => {
      calls++
      const ids = [...prompt.matchAll(/"id":"(\w+)"/g)].map((m) => m[1])
      if (ids.length > 1) throw Object.assign(new Error('bad shape'), { status: 400 })
      return { results: ids.map((id) => item(id)) }
    },
  }
  const out = await extractRealEstateBatch({ groq, logger: createLogger(LOG_PATH), delay: noDelay }, [
    cand('1'),
    cand('2'),
  ])
  expect([...out.keys()].sort()).toEqual(['1', '2'])
  expect(calls).toBeGreaterThan(2)
})

test('extractRealEstateBatch stops the run on a 429 quota error', async () => {
  const groq: JsonModelClient = {
    generateJson: async () => {
      throw Object.assign(new Error('quota'), { status: 429 })
    },
  }
  await expect(
    extractRealEstateBatch({ groq, logger: createLogger(LOG_PATH), delay: noDelay }, [cand('1')]),
  ).rejects.toThrow()
})

test('extractRealEstateBatch retries the listings the model left out of its response', async () => {
  let calls = 0
  const groq: JsonModelClient = {
    generateJson: async (prompt: string) => {
      calls++
      const ids = [...prompt.matchAll(/"id":"(\w+)"/g)].map((m) => m[1])
      // The model drops the back half of whatever it is given.
      return { results: ids.slice(0, Math.ceil(ids.length / 2)).map((id) => item(id)) }
    },
  }
  const out = await extractRealEstateBatch({ groq, logger: createLogger(LOG_PATH), delay: noDelay }, [
    cand('1'),
    cand('2'),
    cand('3'),
  ])
  expect([...out.keys()].sort()).toEqual(['1', '2', '3'])
  expect(calls).toBe(2)
})

test('extractRealEstateBatch retries missing listings only once, so a stubborn model cannot loop', async () => {
  let calls = 0
  const groq: JsonModelClient = {
    generateJson: async () => {
      calls++
      return { results: [] }
    },
  }
  const out = await extractRealEstateBatch({ groq, logger: createLogger(LOG_PATH), delay: noDelay }, [
    cand('1'),
    cand('2'),
  ])
  expect(out.size).toBe(0)
  expect(calls).toBe(2)
})

test('extractRealEstateBatch halves of a split missing-listing retry do not start another retry of their own', async () => {
  const singleCalls: string[] = []
  let calls = 0
  const groq: JsonModelClient = {
    generateJson: async (prompt: string) => {
      calls++
      const ids = [...prompt.matchAll(/"id":"(\w+)"/g)].map((m) => m[1])
      // First call answers with nothing, so all 4 go to the missing retry; that
      // retry keeps failing at size > 1 and splits down to single listings.
      if (calls === 1) return { results: [] }
      if (ids.length > 1) throw Object.assign(new Error('bad shape'), { status: 400 })
      singleCalls.push(ids[0])
      return { results: [] }
    },
  }
  const out = await extractRealEstateBatch({ groq, logger: createLogger(LOG_PATH), delay: noDelay }, [
    cand('1'),
    cand('2'),
    cand('3'),
    cand('4'),
  ])
  expect(out.size).toBe(0)
  expect(singleCalls.sort()).toEqual(['1', '2', '3', '4'])
})

test('the extractor only uses gpt-oss-120b, never the qwen fallbacks that fail its schema', () => {
  expect(EXTRACTOR_MODELS).toEqual(['openai/gpt-oss-120b'])
})

test('the extractor asks for low reasoning effort with an output cap that fits the free-tier 8000 TPM limit', () => {
  expect(EXTRACTOR_REQUEST_OPTIONS).toEqual({ reasoningEffort: 'low', maxCompletionTokens: 4096 })
})
