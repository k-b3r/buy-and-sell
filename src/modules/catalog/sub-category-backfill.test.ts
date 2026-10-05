import { existsSync, rmSync, readFileSync } from 'node:fs'
import { runSubCategoryBackfill } from './sub-category-backfill'
import { createLogger } from '../../platform/logger'
import type { GroqClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { SubCategoryBackfillCandidate } from './products'

const LOG_PATH = 'data/tmp-backfill-sub-categories.log'

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

test('updates sub_category for each product in the batch response, in a single call per batch', async () => {
  const groq = fakeGroq({
    results: [
      { id: '363', sub_category: 'Smartphones' },
      { id: '17', sub_category: 'Graphics Cards' },
    ],
  })
  const { db, updateCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: SubCategoryBackfillCandidate[] = [
    { id: 363, base_model: 'iPhone 12', variant_tier: 'Mini', category: 'Phones & Tablets' },
    { id: 17, base_model: 'RTX 2060', variant_tier: null, category: 'PC Components' },
  ]

  await runSubCategoryBackfill({ groq, db, logger }, candidates)

  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0]).toEqual([363, 'Smartphones', 17, 'Graphics Cards'])
})

test('batches candidates at BATCH_SIZE per Groq call', async () => {
  let callCount = 0
  const groq: GroqClient = {
    generateJson: async () => {
      callCount += 1
      return { results: [] }
    },
  }
  const { db } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: SubCategoryBackfillCandidate[] = Array.from({ length: 220 }, (_, i) => ({
    id: i + 1,
    base_model: `Product ${i + 1}`,
    variant_tier: null,
    category: 'Other',
  }))

  await runSubCategoryBackfill({ groq, db, logger }, candidates)

  expect(callCount).toBe(5)
})

test('a malformed batch response (no results array) is logged and skipped, without crashing the run', async () => {
  const groq = fakeGroq({ not: 'the right shape' })
  const { db, updateCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: SubCategoryBackfillCandidate[] = [{ id: 1, base_model: 'X', variant_tier: null, category: 'Other' }]

  await runSubCategoryBackfill({ groq, db, logger }, candidates)

  expect(updateCalls).toHaveLength(0)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[ERROR]')
})

test('an item with a sub-category outside the fixed list is logged and skipped, while valid items still update', async () => {
  const groq = fakeGroq({
    results: [
      { id: '1', sub_category: 'Smartphones' },
      { id: '2', sub_category: 'Made Up Sub-Category' },
    ],
  })
  const { db, updateCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: SubCategoryBackfillCandidate[] = [
    { id: 1, base_model: 'A', variant_tier: null, category: 'Phones & Tablets' },
    { id: 2, base_model: 'B', variant_tier: null, category: 'Other' },
  ]

  await runSubCategoryBackfill({ groq, db, logger }, candidates)

  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0]).toEqual([1, 'Smartphones'])
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[WARN]')
})

test('an item whose id has no matching candidate in the batch is logged and skipped', async () => {
  const groq = fakeGroq({ results: [{ id: '999', sub_category: 'Other' }] })
  const { db, updateCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: SubCategoryBackfillCandidate[] = [{ id: 1, base_model: 'A', variant_tier: null, category: 'Other' }]

  await runSubCategoryBackfill({ groq, db, logger }, candidates)

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
  const candidates: SubCategoryBackfillCandidate[] = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1,
    base_model: `Product ${i + 1}`,
    variant_tier: null,
    category: 'Other',
  }))

  await expect(runSubCategoryBackfill({ groq, db, logger }, candidates)).resolves.toBeUndefined()

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
      return { results: [{ id: '1', sub_category: 'Other' }] }
    },
  }
  const { db, updateCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: SubCategoryBackfillCandidate[] = [{ id: 1, base_model: 'X', variant_tier: null, category: 'Other' }]
  const delays: number[] = []

  await runSubCategoryBackfill(
    {
      groq,
      db,
      logger,
      delay: async (ms) => {
        delays.push(ms)
      },
    },
    candidates,
  )

  expect(callCount).toBe(2)
  expect(updateCalls).toHaveLength(1)
  expect(delays).toEqual([3000])
})

test('a persistent non-quota Groq error at batch size 1 gives up on that single item, logged, but continues with the next batch', async () => {
  let callCount = 0
  const groq: GroqClient = {
    generateJson: async () => {
      callCount += 1
      if (callCount <= 3) throw new Error('400 json_validate_failed: unexpected nesting')
      return { results: [{ id: '2', sub_category: 'Other' }] }
    },
  }
  const { db, updateCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: SubCategoryBackfillCandidate[] = [
    { id: 1, base_model: 'X', variant_tier: null, category: 'Other' },
    { id: 2, base_model: 'Y', variant_tier: null, category: 'Other' },
  ]

  await runSubCategoryBackfill({ groq, db, logger, delay: async () => {} }, candidates, 1)

  expect(callCount).toBe(4)
  // updateProductSubCategories no-ops on an empty assignment list, so the
  // failed batch (size 1, empty result) issues no query at all — only the
  // successful second batch shows up here.
  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0]).toEqual([2, 'Other'])
  const logContents = readFileSync(LOG_PATH, 'utf-8')
  expect(logContents).toContain('[ERROR]')
  expect(logContents).toContain('even at batch size 1')
  expect(logContents).toContain('skipping')
})

test('a persistent non-quota Groq error on a multi-item batch splits it in half and retries each half independently', async () => {
  // Confirmed live 2026-08-28: gpt-oss-120b occasionally wraps a 100-item
  // results array as {results: {items: [...]}} instead of a flat array,
  // which Groq's own strict-mode schema validator rejects as a 400 before
  // any content comes back. A smaller array gives the model less room to
  // lose track of the shape mid-generation, so halving on failure is a real
  // mitigation - not just retrying the same odds again.
  const calls: number[] = [] // batch sizes requested, in order
  const groq: GroqClient = {
    generateJson: async (prompt: string) => {
      const size = [...prompt.matchAll(/\[id: /g)].length
      calls.push(size)
      // The original batch of 4 always fails; once split down to size <= 2,
      // it succeeds immediately.
      if (size > 2) throw new Error('400 json_validate_failed: unexpected nesting')
      const ids = [...prompt.matchAll(/\[id: (\S+)\]/g)].map((m) => m[1])
      return { results: ids.map((id) => ({ id, sub_category: 'Other' })) }
    },
  }
  const { db, updateCalls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: SubCategoryBackfillCandidate[] = [1, 2, 3, 4].map((id) => ({
    id,
    base_model: `P${id}`,
    variant_tier: null,
    category: 'Other',
  }))

  await runSubCategoryBackfill({ groq, db, logger, delay: async () => {} }, candidates)

  // 3 failed attempts at size 4, then splits into two size-2 halves, each succeeding on its first try.
  expect(calls).toEqual([4, 4, 4, 2, 2])
  expect(updateCalls).toHaveLength(1) // one roll-up update for the whole original batch
  expect(updateCalls[0]).toEqual([1, 'Other', 2, 'Other', 3, 'Other', 4, 'Other'])
  const logContents = readFileSync(LOG_PATH, 'utf-8')
  expect(logContents).toContain('splitting into 2 + 2 and retrying')
})

test('a real 429 quota error still stops the whole run, not just the current batch', async () => {
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
  const candidates: SubCategoryBackfillCandidate[] = [
    { id: 1, base_model: 'X', variant_tier: null, category: 'Other' },
    { id: 2, base_model: 'Y', variant_tier: null, category: 'Other' },
  ]

  await runSubCategoryBackfill({ groq, db, logger, delay: async () => {} }, candidates, 1)

  expect(callCount).toBe(1)
  expect(updateCalls).toHaveLength(0)
})
