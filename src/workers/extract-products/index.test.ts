import { existsSync, rmSync, readFileSync } from 'node:fs'
import { runProductExtraction } from './index'
import type { ExtractionClients } from './index'
import { createLogger } from '../../platform/logger'
import { normalizeVariantTier } from '../../domains/marketplace'
import type { GeminiClient, GroqClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { ExtractionCandidate } from '../../domains/marketplace/storage/products'

const LOG_PATH = 'data/tmp-extract.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function fakeGroq(response: unknown): GroqClient {
  return { generateJson: async () => response }
}

function unusedGemini(): GeminiClient {
  return {
    generateJson: async () => {
      throw new Error('Gemini should not be called')
    },
    generateGroundedText: async () => {
      throw new Error('not used by product extraction')
    },
  }
}

// Happy-path helper: Groq (primary) returns the given response, Gemini
// (fallback) throws if it's ever reached — proves Groq alone is enough.
function fakeClients(response: unknown): ExtractionClients {
  return { groq: fakeGroq(response), gemini: unusedGemini() }
}

function fakeDb(): DbClient {
  return fakeDbWithCalls().db
}

function fakeDbWithCalls(): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const products: { id: number; normalized: string; variantNormalized: string | null }[] = []
  const calls: { sql: string; params: unknown[] }[] = []
  let nextId = 1
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        if (sql.startsWith('SELECT')) {
          const [normalized, variantNormalized] = params as [string, string | null]
          const match = products.find((p) => p.normalized === normalized && p.variantNormalized === variantNormalized)
          return { rows: match ? [{ id: match.id }] : [] }
        }
        if (sql.startsWith('INSERT')) {
          const [, normalized, , variantNormalized] = params as [string, string, string | null, string | null]
          const id = nextId++
          products.push({ id, normalized, variantNormalized })
          return { rows: [{ id }] }
        }
        return { rows: [] } // UPDATE listings ...
      },
    },
  }
}

test('assigns each listing to a product via a single batched UPDATE, keyed by the Groq response id', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'iPhone 13' },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    { id: '1', title: 'RTX 3060 for sale', description: null },
    { id: '2', title: 'iPhone 13 rush', description: null },
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(clients, db, logger, candidates, { batchSize: 25 })

  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE listings'))
  expect(updateCall?.params).toEqual(['1', 1, '2', 2])
})

test('two listings with the same base_model get the same product_id', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'RTX 3060' },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    { id: '1', title: 'RTX 3060 for sale', description: null },
    { id: '2', title: 'RTX 3060 OC', description: null },
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(clients, db, logger, candidates, { batchSize: 25 })

  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE listings'))
  expect(updateCall?.params).toEqual(['1', 1, '2', 1])
})

test('passes category through to findOrCreateProduct on the INSERT', async () => {
  const clients = fakeClients([{ id: '1', base_model: 'RTX 3060', category: 'PC Components' }])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [{ id: '1', title: 'RTX 3060 for sale', description: null }]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(clients, db, logger, candidates, { batchSize: 25 })

  const insertCall = calls.find((c) => c.sql.startsWith('INSERT'))
  expect(insertCall?.params).toEqual(['RTX 3060', 'rtx 3060', null, null, 'PC Components', null])
})

test('a missing or non-string category falls back to null rather than skipping the whole item', async () => {
  const clients = fakeClients([{ id: '1', base_model: 'RTX 3060' }])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [{ id: '1', title: 'RTX 3060 for sale', description: null }]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(clients, db, logger, candidates, { batchSize: 25 })

  const insertCall = calls.find((c) => c.sql.startsWith('INSERT'))
  expect(insertCall?.params).toEqual(['RTX 3060', 'rtx 3060', null, null, null, null])
  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE listings'))
  expect(updateCall?.params).toEqual(['1', 1])
})

test('passes sub_category through to findOrCreateProduct on the INSERT', async () => {
  const clients = fakeClients([{ id: '1', base_model: 'RTX 3060', category: 'PC Components', sub_category: 'Graphics Cards' }])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [{ id: '1', title: 'RTX 3060 for sale', description: null }]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(clients, db, logger, candidates, { batchSize: 25 })

  const insertCall = calls.find((c) => c.sql.startsWith('INSERT'))
  expect(insertCall?.params).toEqual(['RTX 3060', 'rtx 3060', null, null, 'PC Components', 'Graphics Cards'])
})

test('a missing or non-string sub_category falls back to null rather than skipping the whole item', async () => {
  const clients = fakeClients([{ id: '1', base_model: 'RTX 3060', category: 'PC Components' }])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [{ id: '1', title: 'RTX 3060 for sale', description: null }]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(clients, db, logger, candidates, { batchSize: 25 })

  const insertCall = calls.find((c) => c.sql.startsWith('INSERT'))
  expect(insertCall?.params).toEqual(['RTX 3060', 'rtx 3060', null, null, 'PC Components', null])
})

test('candidate list passed in is already the pending set — getExtractionCandidates does the filtering, not this function', async () => {
  let promptedIds: string[] = []
  const groq: GroqClient = {
    generateJson: async (prompt: string) => {
      promptedIds = [...prompt.matchAll(/\[id: (\S+)\]/g)].map((m) => m[1])
      return [{ id: '2', base_model: 'iPhone 13' }]
    },
  }
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [{ id: '2', title: 'iPhone 13 rush', description: null }]

  await runProductExtraction({ groq, gemini: unusedGemini() }, fakeDb(), logger, candidates, { batchSize: 25 })

  expect(promptedIds).toEqual(['2'])
})

test('batches all product_id assignments from one Groq batch into a single UPDATE call', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'iPhone 13' },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    { id: '1', title: 'RTX 3060 for sale', description: null },
    { id: '2', title: 'iPhone 13 rush', description: null },
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(clients, db, logger, candidates, { batchSize: 25 })

  const updateCalls = calls.filter((c) => c.sql.startsWith('UPDATE listings'))
  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0].sql).toContain('FROM (VALUES')
  expect(updateCalls[0].params).toEqual(['1', 1, '2', 2])
})

test('runs discount-notification detection for every assigned listing right after the batched UPDATE, per batch', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'iPhone 13' },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    { id: '1', title: 'RTX 3060 for sale', description: null },
    { id: '2', title: 'iPhone 13 rush', description: null },
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(clients, db, logger, candidates, { batchSize: 25 })

  const updateIndex = calls.findIndex((c) => c.sql.startsWith('UPDATE listings'))
  const discountIndex = calls.findIndex((c) => c.sql.includes('discount_notifications'))
  expect(discountIndex).toBeGreaterThan(-1)
  expect(discountIndex).toBeGreaterThan(updateIndex)
  expect(calls[discountIndex].params).toEqual([['1', '2']])
})

test('resolves each distinct base_model only once per run, even across multiple listings', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'RTX 3060' },
    { id: '3', base_model: 'iPhone 13' },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    { id: '1', title: 'RTX 3060', description: null },
    { id: '2', title: 'RTX 3060 OC', description: null },
    { id: '3', title: 'iPhone 13', description: null },
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(clients, db, logger, candidates, { batchSize: 25 })

  // 2 distinct base models, each a SELECT (miss) + INSERT = 4 total product-lookup
  // calls — not 5+, which is what re-resolving the repeated "RTX 3060" would cost.
  const productLookupCalls = calls.filter((c) => c.sql.startsWith('SELECT') || c.sql.startsWith('INSERT'))
  expect(productLookupCalls).toHaveLength(4)
})

test('a known alias base_model canonicalizes before product lookup, collapsing onto the canonical product', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'PS5' },
    { id: '2', base_model: 'PlayStation 5' },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    { id: '1', title: 'PS5 for sale', description: null },
    { id: '2', title: 'PlayStation 5 console', description: null },
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(clients, db, logger, candidates, { batchSize: 25 })

  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE listings'))
  expect(updateCall?.params).toEqual(['1', 1, '2', 1])
  const insertCalls = calls.filter((c) => c.sql.startsWith('INSERT'))
  expect(insertCalls).toHaveLength(1)
  expect(insertCalls[0].params[0]).toBe('PlayStation 5')
})

test('a listing with a variant guess gets a different product_id than one without', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'RTX 3060', variant: 'OC' },
    { id: '2', base_model: 'RTX 3060' },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    { id: '1', title: 'RTX 3060 OC Asus', description: null },
    { id: '2', title: 'RTX 3060', description: null },
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(clients, db, logger, candidates, { batchSize: 25 })

  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE listings'))
  const params = updateCall?.params as [string, number, string, number]
  expect(params[1]).not.toBe(params[3])
})

test('an empty string variant is treated as no variant at all', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'RTX 3060', variant: '' },
    { id: '2', base_model: 'RTX 3060' },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    { id: '1', title: 'RTX 3060', description: null },
    { id: '2', title: 'RTX 3060', description: null },
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(clients, db, logger, candidates, { batchSize: 25 })

  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE listings'))
  const params = updateCall?.params as [string, number, string, number]
  expect(params[1]).toBe(params[3])
})

test('OC / Founders edition / Founder\'s edition: OC stays separate, the two spellings of the same edition collapse', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'RTX 3060', variant: 'OC' },
    { id: '2', base_model: 'RTX 3060', variant: 'Founders edition' },
    { id: '3', base_model: 'RTX 3060', variant: "Founder's edition" },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    { id: '1', title: 'RTX 3060 OC', description: null },
    { id: '2', title: 'RTX 3060 Founders edition', description: null },
    { id: '3', title: "RTX 3060 Founder's edition", description: null },
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(clients, db, logger, candidates, { batchSize: 25 })

  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE listings'))
  const params = updateCall?.params as [string, number, string, number, string, number]
  expect(params[1]).not.toBe(params[3])
  expect(params[3]).toBe(params[5])
  expect(normalizeVariantTier('Founders edition')).toBe(normalizeVariantTier("Founder's edition"))
})

test('waits between batches but not before the first one or after the last one', async () => {
  const clients = fakeClients([{ id: '1', base_model: 'RTX 3060' }])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    { id: '1', title: 'RTX 3060', description: null },
    { id: '2', title: 'iPhone 13', description: null },
    { id: '3', title: 'Sony WH-1000XM4', description: null },
  ]
  const delays: number[] = []
  const fakeDelay = async (ms: number) => {
    delays.push(ms)
  }

  await runProductExtraction(clients, fakeDb(), logger, candidates, { batchSize: 1, delayMs: 5000 }, fakeDelay)

  expect(delays).toEqual([5000, 5000])
})

test('logs batch progress and a cumulative running total as it goes', async () => {
  const clients = fakeClients([{ id: '1', base_model: 'RTX 3060' }])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    { id: '1', title: 'RTX 3060', description: null },
    { id: '2', title: 'iPhone 13', description: null },
    { id: '3', title: 'Sony WH-1000XM4', description: null },
  ]

  await runProductExtraction(clients, fakeDb(), logger, candidates, { batchSize: 1, delayMs: 0 })

  const log = readFileSync(LOG_PATH, 'utf-8')
  expect(log).toContain('batch 1/3')
  expect(log).toContain('batch 2/3')
  expect(log).toContain('batch 3/3')
  expect(log).toContain('3/3 pending processed (100%)')
})

test('logs a per-batch summary with assigned and skipped counts', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2' }, // missing base_model -> skipped
    { id: 'not-a-real-listing', base_model: 'Ghost' }, // no matching candidate -> skipped
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    { id: '1', title: 'RTX 3060', description: null },
    { id: '2', title: 'Unknown thing', description: null },
  ]

  await runProductExtraction(clients, fakeDb(), logger, candidates, { batchSize: 25 })

  const log = readFileSync(LOG_PATH, 'utf-8')
  expect(log).toContain('batch 1/1 done: 1 assigned, 2 skipped')
})

test('a malformed batch response is logged and skipped, without crashing the run', async () => {
  const clients = fakeClients({ not: 'an array' })
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [{ id: '1', title: 'RTX 3060', description: null }]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(clients, db, logger, candidates, { batchSize: 25 })

  expect(calls.some((c) => c.sql.startsWith('UPDATE listings'))).toBe(false)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[ERROR]')
})

test('a transient (non-quota) Groq error is retried with exponential backoff and can still succeed', async () => {
  let callCount = 0
  const groq: GroqClient = {
    generateJson: async () => {
      callCount += 1
      if (callCount < 3) {
        throw new Error('503 UNAVAILABLE: high demand')
      }
      return [{ id: '1', base_model: 'RTX 3060' }]
    },
  }
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [{ id: '1', title: 'RTX 3060', description: null }]
  const { db, calls } = fakeDbWithCalls()
  const delays: number[] = []

  await runProductExtraction({ groq, gemini: unusedGemini() }, db, logger, candidates, { batchSize: 25 }, async (ms) => {
    delays.push(ms)
  })

  expect(callCount).toBe(3)
  expect(delays).toEqual([30000, 60000])
  expect(calls.some((c) => c.sql.startsWith('UPDATE listings'))).toBe(true)
})

test('Groq quota exhaustion falls through to Gemini, which succeeds', async () => {
  const groq: GroqClient = {
    generateJson: async () => {
      const err = new Error('RESOURCE_EXHAUSTED') as Error & { status: number }
      err.status = 429
      throw err
    },
  }
  let geminiCalled = false
  const gemini: GeminiClient = {
    generateJson: async () => {
      geminiCalled = true
      return [{ id: '1', base_model: 'RTX 3060' }]
    },
    generateGroundedText: async () => {
      throw new Error('not used by product extraction')
    },
  }
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [{ id: '1', title: 'RTX 3060', description: null }]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ groq, gemini }, db, logger, candidates, { batchSize: 25 }, async () => {})

  expect(geminiCalled).toBe(true)
  expect(calls.some((c) => c.sql.startsWith('UPDATE listings'))).toBe(true)
  const log = readFileSync(LOG_PATH, 'utf-8')
  expect(log).toContain('Groq quota exhausted')
  expect(log).toContain('falling back to Gemini')
})

test('Groq retries exhausted (non-quota) falls through to Gemini, which succeeds', async () => {
  let groqCallCount = 0
  const groq: GroqClient = {
    generateJson: async () => {
      groqCallCount += 1
      throw new Error('503 UNAVAILABLE: high demand')
    },
  }
  const gemini: GeminiClient = {
    generateJson: async () => [{ id: '1', base_model: 'RTX 3060' }],
    generateGroundedText: async () => {
      throw new Error('not used by product extraction')
    },
  }
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [{ id: '1', title: 'RTX 3060', description: null }]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ groq, gemini }, db, logger, candidates, { batchSize: 25 }, async () => {})

  expect(groqCallCount).toBe(5)
  expect(calls.some((c) => c.sql.startsWith('UPDATE listings'))).toBe(true)
})

test('both Groq and Gemini exhausted stops the run cleanly', async () => {
  const groq: GroqClient = {
    generateJson: async () => {
      const err = new Error('RESOURCE_EXHAUSTED') as Error & { status: number }
      err.status = 429
      throw err
    },
  }
  const gemini: GeminiClient = {
    generateJson: async () => {
      const err = new Error('RESOURCE_EXHAUSTED') as Error & { status: number }
      err.status = 429
      throw err
    },
    generateGroundedText: async () => {
      throw new Error('not used by product extraction')
    },
  }
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [{ id: '1', title: 'RTX 3060', description: null }]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ groq, gemini }, db, logger, candidates, { batchSize: 25 }, async () => {})

  expect(calls.some((c) => c.sql.startsWith('UPDATE listings'))).toBe(false)
  const log = readFileSync(LOG_PATH, 'utf-8')
  expect(log).toContain('Groq quota exhausted')
  expect(log).toContain('Gemini quota exhausted across all configured keys too')
})

test('a null description is sent to Groq as an empty string, not "null"', async () => {
  let capturedPrompt = ''
  const groq: GroqClient = {
    generateJson: async (prompt: string) => {
      capturedPrompt = prompt
      return [{ id: '1', base_model: 'RTX 3060' }]
    },
  }
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [{ id: '1', title: 'RTX 3060', description: null }]

  await runProductExtraction({ groq, gemini: unusedGemini() }, fakeDb(), logger, candidates, { batchSize: 25 })

  expect(capturedPrompt).toContain('desc: ""')
})
