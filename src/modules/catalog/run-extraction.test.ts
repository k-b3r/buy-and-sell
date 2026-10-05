import { existsSync, rmSync, readFileSync } from 'node:fs'
import { runProductExtraction } from './run-extraction'
import type { ExtractionClients } from './run-extraction'
import { createLogger } from '../../platform/logger'
import { normalizeVariantTier } from './products'
import type { GeminiClient, GroqClient, ExaClient, TavilyClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { ExtractionCandidate } from './product-storage'

const LOG_PATH = 'data/tmp-extract.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

// A bare array response is auto-wrapped in the {results: [...]} envelope
// EXTRACTION_RESPONSE_SCHEMA actually requires (Groq rejects an array-rooted
// schema - see products.ts) - keeps every test below terse. A non-array
// response (e.g. the malformed-response test) passes through untouched.
function fakeGroq(response: unknown): GroqClient {
  return { generateJson: async () => (Array.isArray(response) ? { results: response } : response) }
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

// Retail "not found" by default - ensureProductPriced excludes the product
// on its first attempt (no secondhand call ever made), which is the
// cheapest path for tests that don't care about pricing at all. Tests that
// DO care override exa/tavily/gemini explicitly.
function fakeExa(): ExaClient {
  return { searchStructured: async () => ({ output: { content: { found: false } } }) }
}
function fakeTavily(): TavilyClient {
  return { search: async () => ({ answer: null, results: [] }) }
}

function withPricingDefaults(clients: { groq: GroqClient; gemini: GeminiClient }): ExtractionClients {
  return { ...clients, exa: fakeExa(), tavily: fakeTavily() }
}

// Happy-path helper: Groq (primary) returns the given response, Gemini
// (fallback) throws if it's ever reached — proves Groq alone is enough.
// Pricing defaults to "retail not found" (see fakeExa/fakeTavily above) so
// the product gets excluded fast and existing assertions about
// UPDATE listings/INSERT INTO products aren't affected by pricing calls.
function fakeClients(response: unknown): ExtractionClients {
  return withPricingDefaults({ groq: fakeGroq(response), gemini: unusedGemini() })
}

function candidate(overrides: Partial<ExtractionCandidate> & { id: string; title: string }): ExtractionCandidate {
  return { description: null, condition: null, price_amount: null, ...overrides }
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
        if (sql.includes('product_price_history') && sql.includes('price_lookup_excluded')) {
          // getProductPricingStatus - default: not excluded, no existing prices
          return { rows: [] }
        }
        if (sql.includes('percentile_cont')) {
          // getPeerMedianPrice - default: no sibling median available
          return { rows: [{ clean_median_price: null }] }
        }
        if (sql.startsWith('SELECT') && sql.includes('base_model_normalized')) {
          // findOrCreateProduct's existing-product lookup
          const [normalized, variantNormalized] = params as [string, string | null]
          const match = products.find((p) => p.normalized === normalized && p.variantNormalized === variantNormalized)
          return { rows: match ? [{ id: match.id }] : [] }
        }
        if (sql.startsWith('INSERT INTO products')) {
          const [, normalized, , variantNormalized] = params as [string, string, string | null, string | null]
          const id = nextId++
          products.push({ id, normalized, variantNormalized })
          return { rows: [{ id }] }
        }
        return { rows: [] } // UPDATE listings / UPDATE products / INSERT INTO product_price_history / INSERT INTO discount_notifications
      },
    },
  }
}

// Precise filter for findOrCreateProduct's own calls only - getProductPricingStatus's
// SELECT also starts with 'SELECT', so a bare startsWith('SELECT') filter
// would double-count once pricing calls are involved.
function productLookupCalls(calls: { sql: string }[]): { sql: string }[] {
  return calls.filter((c) => c.sql.includes('base_model_normalized') || c.sql.startsWith('INSERT INTO products'))
}

test('assigns each listing to a product via a single batched UPDATE, keyed by the Groq response id', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'iPhone 13' },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    candidate({ id: '1', title: 'RTX 3060 for sale' }),
    candidate({ id: '2', title: 'iPhone 13 rush' }),
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

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
    candidate({ id: '1', title: 'RTX 3060 for sale' }),
    candidate({ id: '2', title: 'RTX 3060 OC' }),
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE listings'))
  expect(updateCall?.params).toEqual(['1', 1, '2', 1])
})

test('passes category through to findOrCreateProduct on the INSERT', async () => {
  const clients = fakeClients([{ id: '1', base_model: 'RTX 3060', category: 'PC Components' }])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [candidate({ id: '1', title: 'RTX 3060 for sale' })]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

  const insertCall = calls.find((c) => c.sql.startsWith('INSERT INTO products'))
  expect(insertCall?.params).toEqual(['RTX 3060', 'rtx 3060', null, null, 'PC Components', null])
})

test('a missing or non-string category falls back to null rather than skipping the whole item', async () => {
  const clients = fakeClients([{ id: '1', base_model: 'RTX 3060' }])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [candidate({ id: '1', title: 'RTX 3060 for sale' })]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

  const insertCall = calls.find((c) => c.sql.startsWith('INSERT INTO products'))
  expect(insertCall?.params).toEqual(['RTX 3060', 'rtx 3060', null, null, null, null])
  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE listings'))
  expect(updateCall?.params).toEqual(['1', 1])
})

test('passes sub_category through to findOrCreateProduct on the INSERT', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'RTX 3060', category: 'PC Components', sub_category: 'Graphics Cards' },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [candidate({ id: '1', title: 'RTX 3060 for sale' })]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

  const insertCall = calls.find((c) => c.sql.startsWith('INSERT INTO products'))
  expect(insertCall?.params).toEqual(['RTX 3060', 'rtx 3060', null, null, 'PC Components', 'Graphics Cards'])
})

test('a missing or non-string sub_category falls back to null rather than skipping the whole item', async () => {
  const clients = fakeClients([{ id: '1', base_model: 'RTX 3060', category: 'PC Components' }])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [candidate({ id: '1', title: 'RTX 3060 for sale' })]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

  const insertCall = calls.find((c) => c.sql.startsWith('INSERT INTO products'))
  expect(insertCall?.params).toEqual(['RTX 3060', 'rtx 3060', null, null, 'PC Components', null])
})

test('candidate list passed in is already the pending set — getExtractionCandidates does the filtering, not this function', async () => {
  let promptedIds: string[] = []
  const groq: GroqClient = {
    generateJson: async (prompt: string) => {
      promptedIds = [...prompt.matchAll(/\[id: (\S+)\]/g)].map((m) => m[1])
      return { results: [{ id: '2', base_model: 'iPhone 13' }] }
    },
  }
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [candidate({ id: '2', title: 'iPhone 13 rush' })]

  await runProductExtraction(
    { clients: withPricingDefaults({ groq, gemini: unusedGemini() }), db: fakeDb(), logger },
    candidates,
    {
      batchSize: 25,
    },
  )

  expect(promptedIds).toEqual(['2'])
})

test('batches all product_id assignments from one Groq batch into a single UPDATE call', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'iPhone 13' },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    candidate({ id: '1', title: 'RTX 3060 for sale' }),
    candidate({ id: '2', title: 'iPhone 13 rush' }),
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

  const updateCalls = calls.filter((c) => c.sql.startsWith('UPDATE listings'))
  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0].sql).toContain('FROM (VALUES')
  expect(updateCalls[0].params).toEqual(['1', 1, '2', 2])
})

test('resolves each distinct base_model only once per run, even across multiple listings', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'RTX 3060' },
    { id: '3', base_model: 'iPhone 13' },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    candidate({ id: '1', title: 'RTX 3060' }),
    candidate({ id: '2', title: 'RTX 3060 OC' }),
    candidate({ id: '3', title: 'iPhone 13' }),
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

  // 2 distinct base models, each a SELECT (miss) + INSERT = 4 total product-lookup
  // calls — not 5+, which is what re-resolving the repeated "RTX 3060" would cost.
  expect(productLookupCalls(calls)).toHaveLength(4)
})

test('a known alias base_model canonicalizes before product lookup, collapsing onto the canonical product', async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'PS5' },
    { id: '2', base_model: 'PlayStation 5' },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    candidate({ id: '1', title: 'PS5 for sale' }),
    candidate({ id: '2', title: 'PlayStation 5 console' }),
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE listings'))
  expect(updateCall?.params).toEqual(['1', 1, '2', 1])
  const insertCalls = calls.filter((c) => c.sql.startsWith('INSERT INTO products'))
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
    candidate({ id: '1', title: 'RTX 3060 OC Asus' }),
    candidate({ id: '2', title: 'RTX 3060' }),
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

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
    candidate({ id: '1', title: 'RTX 3060' }),
    candidate({ id: '2', title: 'RTX 3060' }),
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE listings'))
  const params = updateCall?.params as [string, number, string, number]
  expect(params[1]).toBe(params[3])
})

test("OC / Founders edition / Founder's edition: OC stays separate, the two spellings of the same edition collapse", async () => {
  const clients = fakeClients([
    { id: '1', base_model: 'RTX 3060', variant: 'OC' },
    { id: '2', base_model: 'RTX 3060', variant: 'Founders edition' },
    { id: '3', base_model: 'RTX 3060', variant: "Founder's edition" },
  ])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    candidate({ id: '1', title: 'RTX 3060 OC' }),
    candidate({ id: '2', title: 'RTX 3060 Founders edition' }),
    candidate({ id: '3', title: "RTX 3060 Founder's edition" }),
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

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
    candidate({ id: '1', title: 'RTX 3060' }),
    candidate({ id: '2', title: 'iPhone 13' }),
    candidate({ id: '3', title: 'Sony WH-1000XM4' }),
  ]
  const delays: number[] = []
  const fakeDelay = async (ms: number) => {
    delays.push(ms)
  }

  await runProductExtraction({ clients, db: fakeDb(), logger, delay: fakeDelay }, candidates, {
    batchSize: 1,
    delayMs: 5000,
  })

  expect(delays).toEqual([5000, 5000])
})

test('logs batch progress and a cumulative running total as it goes', async () => {
  const clients = fakeClients([{ id: '1', base_model: 'RTX 3060' }])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    candidate({ id: '1', title: 'RTX 3060' }),
    candidate({ id: '2', title: 'iPhone 13' }),
    candidate({ id: '3', title: 'Sony WH-1000XM4' }),
  ]

  await runProductExtraction({ clients, db: fakeDb(), logger }, candidates, { batchSize: 1, delayMs: 0 })

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
    candidate({ id: '1', title: 'RTX 3060' }),
    candidate({ id: '2', title: 'Unknown thing' }),
  ]

  await runProductExtraction({ clients, db: fakeDb(), logger }, candidates, { batchSize: 25 })

  const log = readFileSync(LOG_PATH, 'utf-8')
  expect(log).toContain('batch 1/1 done: 1 assigned, 2 skipped')
})

test('a malformed batch response is logged and skipped, without crashing the run', async () => {
  const clients = fakeClients({ not: 'an array' })
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [candidate({ id: '1', title: 'RTX 3060' })]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

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
      return { results: [{ id: '1', base_model: 'RTX 3060' }] }
    },
  }
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [candidate({ id: '1', title: 'RTX 3060' })]
  const { db, calls } = fakeDbWithCalls()
  const delays: number[] = []

  await runProductExtraction(
    {
      clients: withPricingDefaults({ groq, gemini: unusedGemini() }),
      db,
      logger,
      delay: async (ms) => {
        delays.push(ms)
      },
    },
    candidates,
    { batchSize: 25 },
  )

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
      return { results: [{ id: '1', base_model: 'RTX 3060' }] }
    },
    generateGroundedText: async () => {
      throw new Error('not used by product extraction')
    },
  }
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [candidate({ id: '1', title: 'RTX 3060' })]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(
    { clients: withPricingDefaults({ groq, gemini }), db, logger, delay: async () => {} },
    candidates,
    { batchSize: 25 },
  )

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
    generateJson: async () => ({ results: [{ id: '1', base_model: 'RTX 3060' }] }),
    generateGroundedText: async () => {
      throw new Error('not used by product extraction')
    },
  }
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [candidate({ id: '1', title: 'RTX 3060' })]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(
    { clients: withPricingDefaults({ groq, gemini }), db, logger, delay: async () => {} },
    candidates,
    { batchSize: 25 },
  )

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
  const candidates: ExtractionCandidate[] = [candidate({ id: '1', title: 'RTX 3060' })]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction(
    { clients: withPricingDefaults({ groq, gemini }), db, logger, delay: async () => {} },
    candidates,
    { batchSize: 25 },
  )

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
      return { results: [{ id: '1', base_model: 'RTX 3060' }] }
    },
  }
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [candidate({ id: '1', title: 'RTX 3060' })]

  await runProductExtraction(
    { clients: withPricingDefaults({ groq, gemini: unusedGemini() }), db: fakeDb(), logger },
    candidates,
    {
      batchSize: 25,
    },
  )

  expect(capturedPrompt).toContain('desc: ""')
})

// ---- Inline pricing + discount check (2026-08-31 redesign) ----

test('a brand-new product gets priced inline (via Exa) right after getting its product_id', async () => {
  const groq = fakeGroq([{ id: '1', base_model: 'RTX 3060' }])
  const exa: ExaClient = {
    searchStructured: async (query: string) =>
      query.includes('retail')
        ? { output: { content: { found: true, price_low: 14000, price_high: 17000 } } }
        : { output: { content: { found: false } } },
  }
  const clients: ExtractionClients = { groq, gemini: unusedGemini(), exa, tavily: fakeTavily() }
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [candidate({ id: '1', title: 'RTX 3060' })]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

  const insert = calls.find((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(insert?.params).toEqual([
    1,
    14000,
    17000,
    'PHP',
    expect.any(String),
    'exa_new_retail',
    'New',
    null,
    null,
    null,
  ])
})

test('a listing whose product clears the discount bar gets a discount_notifications row inserted inline', async () => {
  const groq = fakeGroq([{ id: '1', base_model: 'Sony WH-1000XM4' }])
  const exa: ExaClient = {
    searchStructured: async () => ({ output: { content: { found: true, price_low: 10000, price_high: 12000 } } }),
  }
  const clients: ExtractionClients = { groq, gemini: unusedGemini(), exa, tavily: fakeTavily() }
  const logger = createLogger(LOG_PATH)
  // Used condition, no secondhand available -> falls back to peer-median,
  // but there's no sibling data either (fakeDbWithCalls' default), so this
  // exercises the retail-not-applicable + no-secondhand + no-peers case:
  // nothing should qualify. Use "New" instead to get a real reference.
  const candidates: ExtractionCandidate[] = [
    candidate({ id: '1', title: 'Sony WH-1000XM4', condition: 'New', price_amount: 7000 }),
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

  // ₱7,000 vs ₱10,000 retail low = 30% off, ₱3,000 profit - clears both bars.
  const notif = calls.find((c) => c.sql.startsWith('INSERT INTO discount_notifications'))
  expect(notif?.params).toEqual(['1', 1, 30, 10000])
})

test('a listing under a product that ends up excluded gets no discount check at all', async () => {
  const groq = fakeGroq([{ id: '1', base_model: 'Refrigerator' }])
  const clients = fakeClients([{ id: '1', base_model: 'Refrigerator' }])
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    candidate({ id: '1', title: 'Refrigerator', condition: 'New', price_amount: 100 }),
  ]
  const { db, calls } = fakeDbWithCalls()

  await runProductExtraction({ clients: { ...clients, groq }, db, logger }, candidates, { batchSize: 25 })

  expect(calls.some((c) => c.sql.startsWith('INSERT INTO discount_notifications'))).toBe(false)
})

test('two listings sharing a brand-new product only trigger one pricing lookup, not two', async () => {
  const groq = fakeGroq([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'RTX 3060' },
  ])
  let exaCalls = 0
  const exa: ExaClient = {
    searchStructured: async () => {
      exaCalls += 1
      return { output: { content: { found: true, price_low: 14000, price_high: 17000 } } }
    },
  }
  const clients: ExtractionClients = { groq, gemini: unusedGemini(), exa, tavily: fakeTavily() }
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    candidate({ id: '1', title: 'RTX 3060' }),
    candidate({ id: '2', title: 'RTX 3060 OC' }),
  ]
  const { db } = fakeDbWithCalls()

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

  // 1 Exa call for retail + 1 for secondhand (Gemini fails first, falls
  // through to this same Exa fake) = 2 calls total for the one shared
  // product - not 4, which is what re-pricing per listing would cost.
  expect(exaCalls).toBe(2)
})

test('a product that already has pricing is not re-priced - existing prices are reused for the discount check', async () => {
  const groq = fakeGroq([{ id: '1', base_model: 'RTX 3060' }])
  let exaCalled = false
  const exa: ExaClient = {
    searchStructured: async () => {
      exaCalled = true
      return { output: { content: { found: false } } }
    },
  }
  const clients: ExtractionClients = { groq, gemini: unusedGemini(), exa, tavily: fakeTavily() }
  const logger = createLogger(LOG_PATH)
  const candidates: ExtractionCandidate[] = [
    candidate({ id: '1', title: 'RTX 3060', condition: 'New', price_amount: 7000 }),
  ]

  const calls: { sql: string; params: unknown[] }[] = []
  const db: DbClient = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      if (sql.includes('product_price_history') && sql.includes('price_lookup_excluded')) {
        // Already priced - retail exists from an earlier run.
        return { rows: [{ price_lookup_excluded: false, price_low: '10000', price_high: '12000', condition: 'New' }] }
      }
      if (sql.startsWith('SELECT') && sql.includes('base_model_normalized')) return { rows: [{ id: 1 }] }
      return { rows: [] }
    },
  }

  await runProductExtraction({ clients, db, logger }, candidates, { batchSize: 25 })

  expect(exaCalled).toBe(false)
  const notif = calls.find((c) => c.sql.startsWith('INSERT INTO discount_notifications'))
  expect(notif?.params).toEqual(['1', 1, 30, 10000])
})
