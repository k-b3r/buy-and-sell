import { existsSync, rmSync, readFileSync } from 'node:fs'
import { runProductEnrichment } from '../src/enrich-products'
import { createLogger } from '../src/logger'
import type { GroqClient } from '../src/groq'
import type { DbClient } from '../src/db'
import type { EnrichmentCandidate } from '../src/enrichment'

const LOG_PATH = 'test/tmp-enrich.log'

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
      },
    ],
  })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [
    { id: 363, base_model: 'iPhone 12', variant_tier: 'Mini', sibling_variants: [] },
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
      },
    ],
  })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [{ id: 17, base_model: 'RTX 2060', variant_tier: null, sibling_variants: [] }]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(upserts[0]).toEqual([17, 'x', 'y', false, null, null, null, 'openai/gpt-oss-120b'])
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
  const candidates: EnrichmentCandidate[] = Array.from({ length: 70 }, (_, i) => ({
    id: i + 1,
    base_model: `Product ${i + 1}`,
    variant_tier: null,
    sibling_variants: [],
  }))

  await runProductEnrichment(groq, db, logger, candidates)

  expect(callCount).toBe(2)
})

test('a malformed batch response (no results array) is logged and skipped, without crashing the run', async () => {
  const groq = fakeGroq({ not: 'the right shape' })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [{ id: 1, base_model: 'X', variant_tier: null, sibling_variants: [] }]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(upserts).toHaveLength(0)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[ERROR]')
})
