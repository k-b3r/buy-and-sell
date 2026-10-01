import { existsSync, rmSync } from 'node:fs'
import { expect, test, afterEach } from 'vitest'
import {
  isWideSpread,
  buildGeminiPrompt,
  parseGeminiPriceResponse,
  buildExaQuery,
  buildExaSystemPrompt,
  parseExaPriceResponse,
  buildTavilyQuery,
  parseTavilyPriceAnswer,
  lookupRetail,
  lookupSecondhand,
  ensureProductPriced,
} from './price-lookup'
import type { PriceLookupCandidate, PriceLookupClients } from './price-lookup'
import { createLogger } from '../../platform/logger'
import type { GeminiClient, ExaClient, TavilyClient } from '../llm-clients'
import type { DbClient } from '../../platform/storage'

const candidate: PriceLookupCandidate = {
  id: 1,
  base_model: 'iPhone 13',
  variant_tier: 'Pro Max',
  description: null,
  sibling_variants: [],
}

test('isWideSpread is true when high is more than 4x low', () => {
  expect(isWideSpread({ low: 1000, high: 5000, currency: 'PHP' })).toBe(true)
})

test('isWideSpread is false within 4x range', () => {
  expect(isWideSpread({ low: 1000, high: 3000, currency: 'PHP' })).toBe(false)
})

test('buildGeminiPrompt includes the product label and variant', () => {
  const prompt = buildGeminiPrompt('secondhand', candidate)
  expect(prompt).toContain('iPhone 13 (Pro Max)')
  expect(prompt).toContain('```json')
})

test('buildGeminiPrompt includes description and sibling variants when present', () => {
  const withContext: PriceLookupCandidate = {
    ...candidate,
    description: 'A 2021 flagship phone',
    sibling_variants: ['Pro', '(base, no variant)'],
  }
  const prompt = buildGeminiPrompt('secondhand', withContext)
  expect(prompt).toContain('A 2021 flagship phone')
  expect(prompt).toContain('Pro, (base, no variant)')
})

test('buildGeminiPrompt differs in wording between retail and secondhand', () => {
  const retail = buildGeminiPrompt('retail', candidate)
  const secondhand = buildGeminiPrompt('secondhand', candidate)
  expect(retail).toContain('brand-new retail price')
  expect(retail).not.toContain('secondhand')
  expect(secondhand).toContain('secondhand/used market price')
})

test('parseGeminiPriceResponse extracts a price range from a fenced json block', () => {
  const text = 'Here is what I found:\n```json\n{"found": true, "price_low": 20000, "price_high": 25000}\n```\nDone.'
  expect(parseGeminiPriceResponse(text)).toEqual({ low: 20000, high: 25000, currency: 'PHP' })
})

test('parseGeminiPriceResponse returns null when found is false', () => {
  const text = '```json\n{"found": false}\n```'
  expect(parseGeminiPriceResponse(text)).toBeNull()
})

test('parseGeminiPriceResponse returns null when there is no fenced json block', () => {
  expect(parseGeminiPriceResponse('I could not find pricing for this.')).toBeNull()
})

test('parseGeminiPriceResponse returns null for malformed json', () => {
  expect(parseGeminiPriceResponse('```json\n{not valid\n```')).toBeNull()
})

test('parseGeminiPriceResponse returns null when price fields are missing', () => {
  expect(parseGeminiPriceResponse('```json\n{"found": true}\n```')).toBeNull()
})

test('buildExaQuery asks for retail or secondhand pricing depending on kind', () => {
  expect(buildExaQuery('retail', candidate)).toContain('brand-new retail price')
  expect(buildExaQuery('secondhand', candidate)).toContain('secondhand used market price')
  expect(buildExaQuery('retail', candidate)).toContain('iPhone 13 (Pro Max)')
})

test('buildExaSystemPrompt differs in wording between retail and secondhand', () => {
  expect(buildExaSystemPrompt('retail', candidate)).toContain('brand-new retail price')
  expect(buildExaSystemPrompt('retail', candidate)).toContain('official brand sites')
  expect(buildExaSystemPrompt('secondhand', candidate)).toContain('secondhand (used) market price')
  expect(buildExaSystemPrompt('secondhand', candidate)).toContain('Facebook Marketplace')
})

test('buildExaSystemPrompt includes disambiguation context when present', () => {
  const withContext: PriceLookupCandidate = { ...candidate, description: 'Flagship phone', sibling_variants: ['Pro'] }
  const prompt = buildExaSystemPrompt('secondhand', withContext)
  expect(prompt).toContain('Flagship phone')
  expect(prompt).toContain('Pro')
})

test('parseExaPriceResponse extracts a price range from output.content', () => {
  const response = { output: { content: { found: true, price_low: 18000, price_high: 22000 } } }
  expect(parseExaPriceResponse(response)).toEqual({ low: 18000, high: 22000, currency: 'PHP' })
})

test('parseExaPriceResponse returns null when found is false', () => {
  expect(parseExaPriceResponse({ output: { content: { found: false } } })).toBeNull()
})

test('parseExaPriceResponse returns null for a malformed response', () => {
  expect(parseExaPriceResponse(null)).toBeNull()
  expect(parseExaPriceResponse({})).toBeNull()
  expect(parseExaPriceResponse({ output: {} })).toBeNull()
})

test('buildTavilyQuery asks for retail or secondhand pricing depending on kind', () => {
  expect(buildTavilyQuery('retail', candidate)).toContain('brand-new retail price')
  expect(buildTavilyQuery('secondhand', candidate)).toContain('secondhand used market price')
  expect(buildTavilyQuery('retail', candidate)).toContain('iPhone 13 (Pro Max)')
})

test('parseTavilyPriceAnswer extracts a price range from peso-prefixed amounts in free text', () => {
  const text = 'Listings range from ₱20,000 to ₱25,000 depending on condition.'
  expect(parseTavilyPriceAnswer(text)).toEqual({ low: 20000, high: 25000, currency: 'PHP' })
})

test('parseTavilyPriceAnswer also matches PHP-prefixed amounts', () => {
  const text = 'Current price is around PHP 15,000.'
  expect(parseTavilyPriceAnswer(text)).toEqual({ low: 15000, high: 15000, currency: 'PHP' })
})

test('parseTavilyPriceAnswer ignores small numbers that are unlikely to be prices', () => {
  const text = 'Released in 2021, comes in 5 colors.'
  expect(parseTavilyPriceAnswer(text)).toBeNull()
})

test('parseTavilyPriceAnswer returns null for null or empty text', () => {
  expect(parseTavilyPriceAnswer(null)).toBeNull()
  expect(parseTavilyPriceAnswer('')).toBeNull()
})

// ---- lookupRetail / lookupSecondhand / ensureProductPriced ----

const LOG_PATH = 'data/tmp-price-lookup-domain.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function fakeDb(): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return { rows: [] }
      },
    },
  }
}

const product: PriceLookupCandidate = {
  id: 2,
  base_model: 'Sony WH-1000XM4',
  variant_tier: null,
  description: 'A noise-cancelling headphone.',
  sibling_variants: [],
}

const GEMINI_NOT_FOUND = '```json\n{"found": false}\n```'

function fakeClients(overrides: Partial<PriceLookupClients> = {}): PriceLookupClients {
  const gemini: GeminiClient = { generateJson: async () => ({}), generateGroundedText: async () => GEMINI_NOT_FOUND }
  const exa: ExaClient = { searchStructured: async () => ({ output: { content: { found: false } } }) }
  const tavily: TavilyClient = { search: async () => ({ answer: null, results: [] }) }
  return { gemini, exa, tavily, ...overrides }
}

test('lookupRetail tries Gemini first', async () => {
  const clients = fakeClients({
    gemini: {
      generateJson: async () => ({}),
      generateGroundedText: async () => '```json\n{"found": true, "price_low": 14499, "price_high": 19999}\n```',
    },
  })
  const logger = createLogger(LOG_PATH)

  const result = await lookupRetail(clients, product, logger, 'Sony WH-1000XM4')

  expect(result).toEqual({
    price: { low: 14499, high: 19999, currency: 'PHP' },
    source: 'gemini_new_retail',
    rawResponse: expect.any(String),
  })
})

test('lookupRetail falls back Gemini -> Exa -> Tavily in order', async () => {
  const clients = fakeClients({
    exa: {
      searchStructured: async () => ({ output: { content: { found: true, price_low: 14499, price_high: 19999 } } }),
    },
  })
  const logger = createLogger(LOG_PATH)

  const result = await lookupRetail(clients, product, logger, 'Sony WH-1000XM4')

  expect(result?.source).toBe('exa_new_retail')
})

test('lookupRetail falls back to Tavily when Gemini and Exa both find nothing', async () => {
  const clients = fakeClients({
    tavily: { search: async () => ({ answer: 'Retail price is ₱14,499 to ₱19,999.', results: [] }) },
  })
  const logger = createLogger(LOG_PATH)

  const result = await lookupRetail(clients, product, logger, 'Sony WH-1000XM4')

  expect(result?.source).toBe('tavily_new_retail')
})

test('lookupRetail returns null when all three providers find nothing', async () => {
  const clients = fakeClients()
  const logger = createLogger(LOG_PATH)

  expect(await lookupRetail(clients, product, logger, 'Sony WH-1000XM4')).toBeNull()
})

test('lookupSecondhand tries Gemini first', async () => {
  const clients = fakeClients({
    gemini: {
      generateJson: async () => ({}),
      generateGroundedText: async () => '```json\n{"found": true, "price_low": 8000, "price_high": 11000}\n```',
    },
  })
  const logger = createLogger(LOG_PATH)

  const result = await lookupSecondhand(clients, product, logger, 'Sony WH-1000XM4')

  expect(result).toEqual({
    price: { low: 8000, high: 11000, currency: 'PHP' },
    source: 'gemini_grounding',
    rawResponse: expect.any(String),
  })
})

test('lookupSecondhand falls back Gemini -> Exa -> Tavily in order', async () => {
  const clients = fakeClients({
    exa: {
      searchStructured: async () => ({ output: { content: { found: true, price_low: 9000, price_high: 10500 } } }),
    },
  })
  const logger = createLogger(LOG_PATH)

  const result = await lookupSecondhand(clients, product, logger, 'Sony WH-1000XM4')

  expect(result?.source).toBe('exa_secondhand')
})

test('lookupSecondhand returns null when all three providers find nothing', async () => {
  const clients = fakeClients()
  const logger = createLogger(LOG_PATH)

  expect(await lookupSecondhand(clients, product, logger, 'Sony WH-1000XM4')).toBeNull()
})

test('ensureProductPriced excludes a text-pattern-generic product before spending any call', async () => {
  const clients = fakeClients()
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const generic: PriceLookupCandidate = {
    id: 5,
    base_model: 'Refrigerator',
    variant_tier: null,
    description: null,
    sibling_variants: [],
  }

  const result = await ensureProductPriced(clients, db, generic, logger)

  expect(result).toEqual({ retail: null, secondhand: null, excluded: true })
  const flagCall = calls.find((c) => c.sql.startsWith('UPDATE products SET price_lookup_excluded'))
  expect(flagCall?.params).toEqual(['too_generic', 5])
})

test('ensureProductPriced excludes the product entirely when retail is not found via any provider - does not try secondhand', async () => {
  let geminiCallCount = 0
  const clients = fakeClients({
    gemini: {
      generateJson: async () => ({}),
      generateGroundedText: async () => {
        geminiCallCount++
        return GEMINI_NOT_FOUND
      },
    },
  })
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  const result = await ensureProductPriced(clients, db, product, logger)

  expect(result).toEqual({ retail: null, secondhand: null, excluded: true })
  // Exactly 1: retail's own Gemini attempt (which also failed, along with
  // Exa/Tavily) - lookupSecondhand's Gemini attempt never happens because
  // ensureProductPriced bails out before trying secondhand at all.
  expect(geminiCallCount).toBe(1)
  const flagCall = calls.find((c) => c.sql.startsWith('UPDATE products SET price_lookup_excluded'))
  expect(flagCall?.params).toEqual(['retail_not_found', 2])
})

test('ensureProductPriced is not excluded when retail succeeds but secondhand does not - just partially priced', async () => {
  const clients = fakeClients({
    exa: {
      searchStructured: async (query: string) =>
        query.includes('brand-new retail')
          ? { output: { content: { found: true, price_low: 14499, price_high: 19999 } } }
          : { output: { content: { found: false } } },
    },
  })
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  const result = await ensureProductPriced(clients, db, product, logger)

  expect(result.excluded).toBe(false)
  expect(result.retail).toEqual({ low: 14499, high: 19999, currency: 'PHP' })
  expect(result.secondhand).toBeNull()
  expect(calls.some((c) => c.sql.startsWith('UPDATE products SET price_lookup_excluded'))).toBe(false)
  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toHaveLength(1)
  expect(inserts[0].params).toEqual([
    2,
    14499,
    19999,
    'PHP',
    expect.any(String),
    'exa_new_retail',
    'New',
    null,
    null,
    null,
  ])
})

test('ensureProductPriced records both retail and secondhand when both succeed', async () => {
  const clients = fakeClients({
    gemini: {
      generateJson: async () => ({}),
      generateGroundedText: async (prompt: string) =>
        prompt.includes('brand-new retail')
          ? '```json\n{"found": true, "price_low": 14499, "price_high": 19999}\n```'
          : '```json\n{"found": true, "price_low": 8000, "price_high": 11000}\n```',
    },
  })
  const { db, calls } = fakeDb()
  const logger = createLogger(LOG_PATH)

  const result = await ensureProductPriced(clients, db, product, logger)

  expect(result).toEqual({
    retail: { low: 14499, high: 19999, currency: 'PHP' },
    secondhand: { low: 8000, high: 11000, currency: 'PHP' },
    excluded: false,
  })
  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))
  expect(inserts).toHaveLength(2)
  expect(inserts[0].params).toEqual([
    2,
    14499,
    19999,
    'PHP',
    expect.any(String),
    'gemini_new_retail',
    'New',
    null,
    null,
    null,
  ])
  expect(inserts[1].params).toEqual([
    2,
    8000,
    11000,
    'PHP',
    expect.any(String),
    'gemini_grounding',
    'Used',
    null,
    null,
    null,
  ])
})
