import { existsSync, rmSync, readFileSync } from 'node:fs'
import { runPriceReview } from './index'
import { createLogger } from '../../logger'
import type { GroqClient } from '../../groq'
import type { DbClient } from '../../storage/client'
import type { PriceReviewCandidate } from '../../price-review'

const LOG_PATH = 'data/tmp-enrich-listing-prices.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function fakeGroq(response: unknown): GroqClient {
  return { generateJson: async () => response }
}

function fakeDb(): { db: DbClient; upserts: unknown[][] } {
  const upserts: unknown[][] = []
  return {
    upserts,
    db: {
      query: async (_sql: string, params: unknown[]) => {
        upserts.push(params)
        return { rows: [] }
      },
    },
  }
}

test('upserts price review data for each listing in the batch response', async () => {
  const groq = fakeGroq({
    results: [
      {
        id: '1000000000000001',
        is_negotiable: true,
        price_low: 7500,
        price_high: 9000,
        reasoning: 'Swap-only listing with a placeholder price; real range inferred from similar listings.',
      },
    ],
  })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: PriceReviewCandidate[] = [
    { id: '1000000000000001', title: 'RTX 2060 6GB FOR SWAP ONLY', description: 'swap only', price_amount: 999999999 },
  ]

  await runPriceReview(groq, db, logger, candidates)

  expect(upserts).toHaveLength(1)
  expect(upserts[0]).toEqual([
    '1000000000000001',
    true,
    7500,
    9000,
    'Swap-only listing with a placeholder price; real range inferred from similar listings.',
    'openai/gpt-oss-120b',
  ])
})

test('no real price determinable: stores null price range', async () => {
  const groq = fakeGroq({
    results: [{ id: '1', is_negotiable: false, price_low: null, price_high: null, reasoning: 'No price in the text.' }],
  })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: PriceReviewCandidate[] = [{ id: '1', title: 'x', description: null, price_amount: 16 }]

  await runPriceReview(groq, db, logger, candidates)

  expect(upserts[0]).toEqual(['1', false, null, null, 'No price in the text.', 'openai/gpt-oss-120b'])
})

test('batches candidates at 35 per Groq call', async () => {
  let callCount = 0
  const groq: GroqClient = {
    generateJson: async () => {
      callCount += 1
      return { results: [] }
    },
  }
  const { db } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: PriceReviewCandidate[] = Array.from({ length: 70 }, (_, i) => ({
    id: String(i + 1),
    title: `Listing ${i + 1}`,
    description: null,
    price_amount: 100,
  }))

  await runPriceReview(groq, db, logger, candidates)

  expect(callCount).toBe(2)
})

test('a malformed batch response (no results array) is logged and skipped, without crashing the run', async () => {
  const groq = fakeGroq({ not: 'the right shape' })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: PriceReviewCandidate[] = [{ id: '1', title: 'x', description: null, price_amount: 16 }]

  await runPriceReview(groq, db, logger, candidates)

  expect(upserts).toHaveLength(0)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[ERROR]')
})

test('a Groq request failure is logged and stops the run cleanly, does not throw', async () => {
  const groq: GroqClient = {
    generateJson: async () => {
      throw new Error('rate limit exceeded')
    },
  }
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: PriceReviewCandidate[] = [{ id: '1', title: 'x', description: null, price_amount: 16 }]

  await expect(runPriceReview(groq, db, logger, candidates)).resolves.toBeUndefined()

  expect(upserts).toHaveLength(0)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('rate limit exceeded')
})
