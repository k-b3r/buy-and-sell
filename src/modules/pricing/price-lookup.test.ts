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
  lookupPrice,
  ensureProductPriced,
  PriceLookupFailedError,
} from './price-lookup'
import type { PriceLookupCandidate, PriceLookupClients } from './price-lookup'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { GeminiClient, ExaClient, TavilyClient } from '../../platform/llm-clients'
import { QuotaExhaustedError, isQuotaError } from '../../platform/llm-clients'
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

test('parseTavilyPriceAnswer drops junk amounts (below ₱100 or a placeholder pattern) by the shared rule', () => {
  const text = 'Prices start at ₱99 or PHP 12,345 but most go for ₱20,000.'
  expect(parseTavilyPriceAnswer(text)).toEqual({ low: 20000, high: 20000, currency: 'PHP' })
})

test('parseTavilyPriceAnswer returns null for null or empty text', () => {
  expect(parseTavilyPriceAnswer(null)).toBeNull()
  expect(parseTavilyPriceAnswer('')).toBeNull()
})

// ---- lookupPrice / ensureProductPriced ----

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

test('lookupPrice retail tries Gemini first', async () => {
  const clients = fakeClients({
    gemini: {
      generateJson: async () => ({}),
      generateGroundedText: async () => '```json\n{"found": true, "price_low": 14499, "price_high": 19999}\n```',
    },
  })
  const logger = createLogger(LOG_PATH)

  const result = await lookupPrice({ clients, logger }, 'retail', product)

  expect(result).toEqual({
    price: { low: 14499, high: 19999, currency: 'PHP' },
    source: 'gemini_new_retail',
    rawResponse: expect.any(String),
  })
})

test('lookupPrice retail falls back Gemini -> Exa -> Tavily in order', async () => {
  const clients = fakeClients({
    exa: {
      searchStructured: async () => ({ output: { content: { found: true, price_low: 14499, price_high: 19999 } } }),
    },
  })
  const logger = createLogger(LOG_PATH)

  const result = await lookupPrice({ clients, logger }, 'retail', product)

  expect(result?.source).toBe('exa_new_retail')
})

test('lookupPrice retail falls back to Tavily when Gemini and Exa both find nothing', async () => {
  const clients = fakeClients({
    tavily: { search: async () => ({ answer: 'Retail price is ₱14,499 to ₱19,999.', results: [] }) },
  })
  const logger = createLogger(LOG_PATH)

  const result = await lookupPrice({ clients, logger }, 'retail', product)

  expect(result?.source).toBe('tavily_new_retail')
})

test('lookupPrice retail returns null when all three providers find nothing', async () => {
  const clients = fakeClients()
  const logger = createLogger(LOG_PATH)

  expect(await lookupPrice({ clients, logger }, 'retail', product)).toBeNull()
})

test('lookupPrice secondhand tries Gemini first', async () => {
  const clients = fakeClients({
    gemini: {
      generateJson: async () => ({}),
      generateGroundedText: async () => '```json\n{"found": true, "price_low": 8000, "price_high": 11000}\n```',
    },
  })
  const logger = createLogger(LOG_PATH)

  const result = await lookupPrice({ clients, logger }, 'secondhand', product)

  expect(result).toEqual({
    price: { low: 8000, high: 11000, currency: 'PHP' },
    source: 'gemini_grounding',
    rawResponse: expect.any(String),
  })
})

test('lookupPrice secondhand falls back Gemini -> Exa -> Tavily in order', async () => {
  const clients = fakeClients({
    exa: {
      searchStructured: async () => ({ output: { content: { found: true, price_low: 9000, price_high: 10500 } } }),
    },
  })
  const logger = createLogger(LOG_PATH)

  const result = await lookupPrice({ clients, logger }, 'secondhand', product)

  expect(result?.source).toBe('exa_secondhand')
})

test('lookupPrice secondhand returns null when all three providers find nothing', async () => {
  const clients = fakeClients()
  const logger = createLogger(LOG_PATH)

  expect(await lookupPrice({ clients, logger }, 'secondhand', product)).toBeNull()
})

function fakeLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return { warnings, info: () => {}, warn: (msg) => warnings.push(msg), error: () => {} }
}

test('lookupPrice secondhand falls back to Tavily when Gemini and Exa both find nothing', async () => {
  const clients = fakeClients({
    tavily: { search: async () => ({ answer: 'Used ones go for ₱8,000 to ₱11,000.', results: [] }) },
  })

  const result = await lookupPrice({ clients, logger: fakeLogger() }, 'secondhand', product)

  expect(result?.source).toBe('tavily_secondhand')
})

test('lookupPrice skips a too-wide range and names the next provider in the warning', async () => {
  const clients = fakeClients({
    gemini: {
      generateJson: async () => ({}),
      generateGroundedText: async () => '```json\n{"found": true, "price_low": 1000, "price_high": 50000}\n```',
    },
    exa: {
      searchStructured: async () => ({ output: { content: { found: true, price_low: 9000, price_high: 10500 } } }),
    },
  })
  const logger = fakeLogger()

  const result = await lookupPrice({ clients, logger }, 'secondhand', product)

  expect(result?.source).toBe('exa_secondhand')
  expect(logger.warnings).toEqual([
    'product 2 (Sony WH-1000XM4): Gemini secondhand range too wide (1000-50000), falling back to Exa',
  ])
})

test('lookupPrice drops a too-wide range from the last provider instead of returning it', async () => {
  const clients = fakeClients({
    tavily: { search: async () => ({ answer: 'Anywhere from ₱1,000 to ₱50,000.', results: [] }) },
  })
  const logger = fakeLogger()

  const result = await lookupPrice({ clients, logger }, 'retail', product)

  expect(result).toBeNull()
  expect(logger.warnings).toEqual(['product 2 (Sony WH-1000XM4): Tavily retail range too wide (1000-50000), dropped'])
})

test('lookupPrice logs a provider error and moves on, with no fallback named after the last provider', async () => {
  const failing = async (): Promise<never> => {
    throw new Error('boom')
  }
  const clients = fakeClients({
    gemini: { generateJson: async () => ({}), generateGroundedText: failing },
    exa: { searchStructured: failing },
    tavily: { search: failing },
  })
  const logger = fakeLogger()

  await expect(lookupPrice({ clients, logger }, 'retail', product)).rejects.toThrow(PriceLookupFailedError)
  expect(logger.warnings).toEqual([
    'product 2 (Sony WH-1000XM4): Gemini retail lookup failed (boom), falling back to Exa',
    'product 2 (Sony WH-1000XM4): Exa retail lookup failed (boom), falling back to Tavily',
    'product 2 (Sony WH-1000XM4): Tavily retail lookup failed (boom)',
  ])
})

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status })
}

function throwing(err: Error): () => Promise<never> {
  return async () => {
    throw err
  }
}

// Every provider errors, at least one on quota/credits: Gemini 429, Exa 402
// (credits), Tavily a transient 503.
function quotaFailingClients(): PriceLookupClients {
  return fakeClients({
    gemini: { generateJson: async () => ({}), generateGroundedText: throwing(httpError(429)) },
    exa: { searchStructured: throwing(httpError(402)) },
    tavily: { search: throwing(httpError(503)) },
  })
}

test('lookupPrice throws a quota error when every provider fails and one of them on quota or credits', async () => {
  const result = lookupPrice({ clients: quotaFailingClients(), logger: fakeLogger() }, 'retail', product)

  await expect(result).rejects.toThrow(QuotaExhaustedError)
})

test('lookupPrice throws a non-quota PriceLookupFailedError when every provider fails transiently', async () => {
  const clients = fakeClients({
    gemini: { generateJson: async () => ({}), generateGroundedText: throwing(httpError(503)) },
    exa: { searchStructured: throwing(new Error('network down')) },
    tavily: { search: throwing(httpError(500)) },
  })

  const err = await lookupPrice({ clients, logger: fakeLogger() }, 'retail', product).catch((e: unknown) => e)

  expect(err).toBeInstanceOf(PriceLookupFailedError)
  expect(isQuotaError(err)).toBe(false)
})

test('lookupPrice falls through a quota error to the next provider that has a price', async () => {
  const clients = fakeClients({
    gemini: { generateJson: async () => ({}), generateGroundedText: throwing(httpError(429)) },
    exa: {
      searchStructured: async () => ({ output: { content: { found: true, price_low: 14499, price_high: 19999 } } }),
    },
  })

  const result = await lookupPrice({ clients, logger: fakeLogger() }, 'retail', product)

  expect(result?.source).toBe('exa_new_retail')
})

test('lookupPrice returns null when one provider really answers not found, even if the others hit quota', async () => {
  const clients = fakeClients({
    gemini: { generateJson: async () => ({}), generateGroundedText: throwing(httpError(429)) },
    exa: { searchStructured: throwing(httpError(402)) },
  })

  expect(await lookupPrice({ clients, logger: fakeLogger() }, 'retail', product)).toBeNull()
})

test('ensureProductPriced leaves the product unexcluded and throws when the retail chain fails on quota', async () => {
  const { db, calls } = fakeDb()

  const result = ensureProductPriced({ clients: quotaFailingClients(), db, logger: fakeLogger() }, product)

  await expect(result).rejects.toThrow(QuotaExhaustedError)
  expect(calls.some((c) => c.sql.startsWith('UPDATE products SET price_lookup_excluded'))).toBe(false)
})

test('ensureProductPriced leaves the product unexcluded and throws when the retail chain fails transiently', async () => {
  const clients = fakeClients({
    gemini: { generateJson: async () => ({}), generateGroundedText: throwing(httpError(503)) },
    exa: { searchStructured: throwing(httpError(500)) },
    tavily: { search: throwing(httpError(500)) },
  })
  const { db, calls } = fakeDb()

  const result = ensureProductPriced({ clients, db, logger: fakeLogger() }, product)

  await expect(result).rejects.toThrow(PriceLookupFailedError)
  expect(calls.some((c) => c.sql.startsWith('UPDATE products SET price_lookup_excluded'))).toBe(false)
})

const RETAIL_FOUND = '```json\n{"found": true, "price_low": 14499, "price_high": 19999}\n```'

// Gemini prices retail, then the secondhand chain errors on every provider.
function secondhandFailingClients(secondhandError: Error): PriceLookupClients {
  return fakeClients({
    gemini: {
      generateJson: async () => ({}),
      generateGroundedText: async (prompt: string) => {
        if (prompt.includes('brand-new retail')) return RETAIL_FOUND
        throw secondhandError
      },
    },
    exa: { searchStructured: throwing(secondhandError) },
    tavily: { search: throwing(secondhandError) },
  })
}

test('ensureProductPriced keeps the retail price when the secondhand chain fails transiently', async () => {
  const { db, calls } = fakeDb()
  const clients = secondhandFailingClients(httpError(503))

  const result = await ensureProductPriced({ clients, db, logger: fakeLogger() }, product)

  expect(result).toEqual({ retail: { low: 14499, high: 19999, currency: 'PHP' }, secondhand: null, excluded: false })
  expect(calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))).toHaveLength(1)
})

test('ensureProductPriced throws when the secondhand chain fails on quota, after saving retail', async () => {
  const { db, calls } = fakeDb()
  const clients = secondhandFailingClients(httpError(429))

  const result = ensureProductPriced({ clients, db, logger: fakeLogger() }, product)

  await expect(result).rejects.toThrow(QuotaExhaustedError)
  expect(calls.filter((c) => c.sql.startsWith('INSERT INTO product_price_history'))).toHaveLength(1)
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

  const result = await ensureProductPriced({ clients, db, logger }, generic)

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

  const result = await ensureProductPriced({ clients, db, logger }, product)

  expect(result).toEqual({ retail: null, secondhand: null, excluded: true })
  // Exactly 1: retail's own Gemini attempt (which also failed, along with
  // Exa/Tavily) - the secondhand Gemini attempt never happens because
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

  const result = await ensureProductPriced({ clients, db, logger }, product)

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

  const result = await ensureProductPriced({ clients, db, logger }, product)

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
