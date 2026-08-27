import { existsSync, rmSync, readFileSync } from 'node:fs'
import { runProductEnrichment } from './index'
import { createLogger } from '../../platform/logger'
import type { GroqClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { EnrichmentCandidate } from '../../enrichment'

const LOG_PATH = 'data/tmp-enrich.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function fakeGroq(response: unknown): GroqClient {
  return { generateJson: async () => response }
}

function fakeDb(): { db: DbClient; upserts: unknown[][]; categoryUpdates: unknown[][] } {
  const upserts: unknown[][] = []
  const categoryUpdates: unknown[][] = []
  return {
    upserts,
    categoryUpdates,
    db: {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('INSERT INTO product_enrichment')) upserts.push(params)
        else if (sql.includes('UPDATE products SET category')) categoryUpdates.push(params)
        return { rows: [] }
      },
    },
  }
}

test('upserts enrichment data for each product in the batch response', async () => {
  const groq = fakeGroq({
    results: [
      {
        id: '363',
        description: 'A compact iPhone.',
        value_drivers: 'Battery health matters most.',
        has_trained_price_knowledge: true,
        trained_price_low: 9000,
        trained_price_high: 13000,
        category: 'Phones & Tablets',
        is_specific_product: true,
        confidence: 'high',
      },
    ],
  })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [
    { id: 363, base_model: 'iPhone 12', variant_tier: 'Mini', sibling_variants: [], category: null },
  ]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(upserts).toHaveLength(1)
  expect(upserts[0]).toEqual([
    363,
    'A compact iPhone.',
    'Battery health matters most.',
    true,
    9000,
    13000,
    'PHP',
    'openai/gpt-oss-120b',
    true,
    'high',
  ])
})

test('has_trained_price_knowledge false with no price fields stores null prices and null currency', async () => {
  const groq = fakeGroq({
    results: [
      {
        id: '17',
        description: 'x',
        value_drivers: 'y',
        has_trained_price_knowledge: false,
        trained_price_low: null,
        trained_price_high: null,
        category: 'PC Components',
        is_specific_product: true,
        confidence: 'high',
      },
    ],
  })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [
    { id: 17, base_model: 'RTX 2060', variant_tier: null, sibling_variants: [], category: null },
  ]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(upserts[0]).toEqual([17, 'x', 'y', false, null, null, null, 'openai/gpt-oss-120b', true, 'high'])
})

test('a product judged generic with high confidence is still upserted with is_specific_product/confidence recorded', async () => {
  const groq = fakeGroq({
    results: [
      {
        id: '5',
        description: 'Movable furnishings.',
        value_drivers: 'n/a',
        has_trained_price_knowledge: false,
        trained_price_low: null,
        trained_price_high: null,
        category: 'Other',
        is_specific_product: false,
        confidence: 'high',
      },
    ],
  })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [
    { id: 5, base_model: 'Furniture', variant_tier: null, sibling_variants: [], category: null },
  ]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(upserts[0]).toEqual([5, 'Movable furnishings.', 'n/a', false, null, null, null, 'openai/gpt-oss-120b', false, 'high'])
})

test('an item with a missing is_specific_product or invalid confidence is logged and skipped as malformed', async () => {
  const groq = fakeGroq({
    results: [
      {
        id: '1',
        description: 'x',
        value_drivers: 'y',
        has_trained_price_knowledge: false,
        trained_price_low: null,
        trained_price_high: null,
        category: 'Other',
        // is_specific_product missing -> malformed
        confidence: 'medium', // not a valid enum value -> malformed
      },
    ],
  })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [
    { id: 1, base_model: 'A', variant_tier: null, sibling_variants: [], category: null },
  ]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(upserts).toHaveLength(0)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[WARN]')
})

test('batches candidates at 20 per Groq call', async () => {
  let callCount = 0
  const groq: GroqClient = {
    generateJson: async () => {
      callCount += 1
      return { results: [] }
    },
  }
  const { db } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    base_model: `Product ${i + 1}`,
    variant_tier: null,
    sibling_variants: [],
    category: null,
  }))

  await runProductEnrichment(groq, db, logger, candidates)

  expect(callCount).toBe(2)
})

test('a malformed batch response (no results array) is logged and skipped, without crashing the run', async () => {
  const groq = fakeGroq({ not: 'the right shape' })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [
    { id: 1, base_model: 'X', variant_tier: null, sibling_variants: [], category: null },
  ]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(upserts).toHaveLength(0)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[ERROR]')
})

test('a malformed item within an otherwise well-formed batch is logged and skipped, while the well-formed item still gets upserted', async () => {
  const groq = fakeGroq({
    results: [
      {
        id: '1',
        description: 'Good description.',
        value_drivers: 'Good drivers.',
        has_trained_price_knowledge: false,
        trained_price_low: null,
        trained_price_high: null,
        category: 'Other',
        is_specific_product: true,
        confidence: 'high',
      },
      {
        id: '2',
        // description missing -> malformed
        value_drivers: 'y',
        has_trained_price_knowledge: true,
        trained_price_low: 100,
        trained_price_high: 200,
        category: 'Other',
        is_specific_product: true,
        confidence: 'high',
      },
    ],
  })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [
    { id: 1, base_model: 'A', variant_tier: null, sibling_variants: [], category: null },
    { id: 2, base_model: 'B', variant_tier: null, sibling_variants: [], category: null },
  ]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(upserts).toHaveLength(1)
  expect(upserts[0]).toEqual([
    1,
    'Good description.',
    'Good drivers.',
    false,
    null,
    null,
    null,
    'openai/gpt-oss-120b',
    true,
    'high',
  ])
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[WARN]')
})

test('an item whose id has no matching candidate in the batch is logged and skipped', async () => {
  const groq = fakeGroq({
    results: [
      {
        id: '999',
        description: 'x',
        value_drivers: 'y',
        has_trained_price_knowledge: false,
        trained_price_low: null,
        trained_price_high: null,
        category: 'Other',
        is_specific_product: true,
        confidence: 'high',
      },
    ],
  })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [
    { id: 1, base_model: 'A', variant_tier: null, sibling_variants: [], category: null },
  ]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(upserts).toHaveLength(0)
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
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = Array.from({ length: 70 }, (_, i) => ({
    id: i + 1,
    base_model: `Product ${i + 1}`,
    variant_tier: null,
    sibling_variants: [],
    category: null,
  }))

  await expect(runProductEnrichment(groq, db, logger, candidates)).resolves.toBeUndefined()

  expect(callCount).toBe(1)
  expect(upserts).toHaveLength(0)
  const logContents = readFileSync(LOG_PATH, 'utf-8')
  expect(logContents).toContain('[ERROR]')
  expect(logContents).toContain('rate_limit_exceeded')
})

test('a non-quota Groq error (e.g. the occasional 400 structural glitch) is retried and can still succeed', async () => {
  let callCount = 0
  const groq: GroqClient = {
    generateJson: async () => {
      callCount += 1
      if (callCount < 2) throw new Error('400 json_validate_failed: unexpected nesting')
      return {
        results: [
          {
            id: '1',
            description: 'x',
            value_drivers: 'y',
            has_trained_price_knowledge: false,
            trained_price_low: null,
            trained_price_high: null,
            category: 'Other',
            is_specific_product: true,
            confidence: 'high',
          },
        ],
      }
    },
  }
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [
    { id: 1, base_model: 'RTX 3060', variant_tier: null, sibling_variants: [], category: null },
  ]
  const delays: number[] = []

  await runProductEnrichment(groq, db, logger, candidates, async (ms) => {
    delays.push(ms)
  })

  expect(callCount).toBe(2)
  expect(upserts).toHaveLength(1)
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
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [
    { id: 1, base_model: 'RTX 3060', variant_tier: null, sibling_variants: [], category: null },
  ]

  await runProductEnrichment(groq, db, logger, candidates, async () => {})

  expect(callCount).toBe(3)
  expect(upserts).toHaveLength(0)
  const logContents = readFileSync(LOG_PATH, 'utf-8')
  expect(logContents).toContain('[ERROR]')
})

test('assigns category via a batched update when the candidate has none and the response includes a valid category', async () => {
  const groq = fakeGroq({
    results: [
      {
        id: '1',
        description: 'x',
        value_drivers: 'y',
        has_trained_price_knowledge: false,
        trained_price_low: null,
        trained_price_high: null,
        category: 'Gaming',
        is_specific_product: true,
        confidence: 'high',
      },
      {
        id: '2',
        description: 'x',
        value_drivers: 'y',
        has_trained_price_knowledge: false,
        trained_price_low: null,
        trained_price_high: null,
        category: 'Audio',
        is_specific_product: true,
        confidence: 'high',
      },
    ],
  })
  const { db, categoryUpdates } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [
    { id: 1, base_model: 'PS5', variant_tier: null, sibling_variants: [], category: null },
    { id: 2, base_model: 'Airpods', variant_tier: null, sibling_variants: [], category: null },
  ]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(categoryUpdates).toHaveLength(1)
  expect(categoryUpdates[0]).toEqual([1, 'Gaming', 2, 'Audio'])
})

test('does not touch category when the candidate already has one, even if Groq returns a category', async () => {
  const groq = fakeGroq({
    results: [
      {
        id: '1',
        description: 'x',
        value_drivers: 'y',
        has_trained_price_knowledge: false,
        trained_price_low: null,
        trained_price_high: null,
        category: 'Gaming',
        is_specific_product: true,
        confidence: 'high',
      },
    ],
  })
  const { db, categoryUpdates } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [
    { id: 1, base_model: 'PS5', variant_tier: null, sibling_variants: [], category: 'Gaming' },
  ]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(categoryUpdates).toHaveLength(0)
})

test('an invalid category is logged and skipped without affecting the enrichment upsert', async () => {
  const groq = fakeGroq({
    results: [
      {
        id: '1',
        description: 'x',
        value_drivers: 'y',
        has_trained_price_knowledge: false,
        trained_price_low: null,
        trained_price_high: null,
        category: 'Made Up Category',
        is_specific_product: true,
        confidence: 'high',
      },
    ],
  })
  const { db, upserts, categoryUpdates } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [
    { id: 1, base_model: 'PS5', variant_tier: null, sibling_variants: [], category: null },
  ]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(upserts).toHaveLength(1)
  expect(categoryUpdates).toHaveLength(0)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[WARN]')
})
