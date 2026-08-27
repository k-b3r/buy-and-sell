import { existsSync, rmSync, readFileSync } from 'node:fs'
import { runCategoryBackfill } from './index'
import { createLogger } from '../../logger'
import type { GroqClient } from '../../groq'
import type { DbClient } from '../../storage'
import type { CategoryBackfillCandidate } from '../../products'

const LOG_PATH = 'data/tmp-backfill-categories.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function fakeGroq(response: unknown): GroqClient {
  return { generateJson: async () => response }
}

function fakeDb(): { db: DbClient; updateCalls: unknown[][] } {
  const updateCalls: unknown[][] = []
  return {
    updateCalls,
    db: {
      query: async (_sql: string, params: unknown[]) => {
        updateCalls.push(params)
        return { rows: [] }
      },
    },
  }
}

test('updates category for each product in the batch response, in a single call per batch', async () => {
  const groq = fakeGroq({
    results: [
      { id: '363', category: 'Phones & Tablets' },
      { id: '17', category: 'PC Components' },
    ],
  })
  const { db, updateCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: CategoryBackfillCandidate[] = [
    { id: 363, base_model: 'iPhone 12', variant_tier: 'Mini' },
    { id: 17, base_model: 'RTX 2060', variant_tier: null },
  ]

  await runCategoryBackfill(groq, db, logger, candidates)

  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0]).toEqual([363, 'Phones & Tablets', 17, 'PC Components'])
})

test('batches candidates at 100 per Groq call', async () => {
  let callCount = 0
  const groq: GroqClient = {
    generateJson: async () => {
      callCount += 1
      return { results: [] }
    },
  }
  const { db } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: CategoryBackfillCandidate[] = Array.from({ length: 220 }, (_, i) => ({
    id: i + 1,
    base_model: `Product ${i + 1}`,
    variant_tier: null,
  }))

  await runCategoryBackfill(groq, db, logger, candidates)

  expect(callCount).toBe(3)
})

test('a malformed batch response (no results array) is logged and skipped, without crashing the run', async () => {
  const groq = fakeGroq({ not: 'the right shape' })
  const { db, updateCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: CategoryBackfillCandidate[] = [{ id: 1, base_model: 'X', variant_tier: null }]

  await runCategoryBackfill(groq, db, logger, candidates)

  expect(updateCalls).toHaveLength(0)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[ERROR]')
})

test('an item with a category outside the fixed list is logged and skipped, while valid items still update', async () => {
  const groq = fakeGroq({
    results: [
      { id: '1', category: 'Phones & Tablets' },
      { id: '2', category: 'Made Up Category' },
    ],
  })
  const { db, updateCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: CategoryBackfillCandidate[] = [
    { id: 1, base_model: 'A', variant_tier: null },
    { id: 2, base_model: 'B', variant_tier: null },
  ]

  await runCategoryBackfill(groq, db, logger, candidates)

  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0]).toEqual([1, 'Phones & Tablets'])
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[WARN]')
})

test('an item whose id has no matching candidate in the batch is logged and skipped', async () => {
  const groq = fakeGroq({ results: [{ id: '999', category: 'Other' }] })
  const { db, updateCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: CategoryBackfillCandidate[] = [{ id: 1, base_model: 'A', variant_tier: null }]

  await runCategoryBackfill(groq, db, logger, candidates)

  expect(updateCalls).toHaveLength(0)
  const logContents = readFileSync(LOG_PATH, 'utf-8')
  expect(logContents).toContain('[WARN]')
  expect(logContents).toContain('999')
})

test('a real 429 quota error is not retried — logged and stops the run cleanly on the first hit', async () => {
  let callCount = 0
  const groq: GroqClient = {
    generateJson: async () => {
      callCount += 1
      const err = new Error('rate_limit_exceeded: daily token limit reached') as Error & { status: number }
      err.status = 429
      throw err
    },
  }
  const { db, updateCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: CategoryBackfillCandidate[] = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1,
    base_model: `Product ${i + 1}`,
    variant_tier: null,
  }))

  await expect(runCategoryBackfill(groq, db, logger, candidates)).resolves.toBeUndefined()

  expect(callCount).toBe(1)
  expect(updateCalls).toHaveLength(0)
  const logContents = readFileSync(LOG_PATH, 'utf-8')
  expect(logContents).toContain('[ERROR]')
  expect(logContents).toContain('rate_limit_exceeded')
})

test('a non-quota Groq error (e.g. an occasional structural glitch) is retried and can still succeed', async () => {
  let callCount = 0
  const groq: GroqClient = {
    generateJson: async () => {
      callCount += 1
      if (callCount < 2) throw new Error('400 json_validate_failed: unexpected nesting')
      return { results: [{ id: '1', category: 'Other' }] }
    },
  }
  const { db, updateCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: CategoryBackfillCandidate[] = [{ id: 1, base_model: 'X', variant_tier: null }]
  const delays: number[] = []

  await runCategoryBackfill(groq, db, logger, candidates, async (ms) => {
    delays.push(ms)
  })

  expect(callCount).toBe(2)
  expect(updateCalls).toHaveLength(1)
  expect(delays).toEqual([3000])
})

test('a persistent non-quota Groq error gives up after 3 attempts, logged, stops the run cleanly', async () => {
  let callCount = 0
  const groq: GroqClient = {
    generateJson: async () => {
      callCount += 1
      throw new Error('400 json_validate_failed: unexpected nesting')
    },
  }
  const { db, updateCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: CategoryBackfillCandidate[] = [{ id: 1, base_model: 'X', variant_tier: null }]

  await runCategoryBackfill(groq, db, logger, candidates, async () => {})

  expect(callCount).toBe(3)
  expect(updateCalls).toHaveLength(0)
  const logContents = readFileSync(LOG_PATH, 'utf-8')
  expect(logContents).toContain('[ERROR]')
})
