import { existsSync, rmSync } from 'node:fs'
import {
  verifyDiscountCandidate,
  precheckDiscountCandidate,
  buildPriceQuery,
  runVerifyDiscountNotifications,
} from './discount-verification'
import { createLogger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import type { VerificationClients } from './discount-verification'
import type { DiscountVerificationCandidate } from './discount-notifications'
import type { TavilyClient, ExaClient, GeminiClient, OpenRouterClient } from '../../platform/llm-clients'

function candidate(overrides: Partial<DiscountVerificationCandidate> = {}): DiscountVerificationCandidate {
  return {
    id: 7,
    listing_id: '123',
    title: 'Sony WH-1000XM5',
    description: 'Used, minor scuff on headband, battery still great, box included',
    condition: 'Used - Good',
    price_amount: 6500,
    base_model: 'Sony WH-1000XM5',
    is_specific_product: true,
    ...overrides,
  }
}

function notImplemented(): never {
  throw new Error('not implemented in this fake')
}

function fakeClients(overrides: {
  tavily?: Partial<TavilyClient>
  exa?: Partial<ExaClient>
  gemini?: Partial<GeminiClient>
  openrouter?: Partial<OpenRouterClient>
}): { tavily: TavilyClient; exa: ExaClient; gemini: GeminiClient; openrouter: OpenRouterClient } {
  return {
    tavily: { search: overrides.tavily?.search ?? notImplemented },
    exa: { searchStructured: overrides.exa?.searchStructured ?? notImplemented },
    gemini: {
      generateJson: overrides.gemini?.generateJson ?? notImplemented,
      generateGroundedText: overrides.gemini?.generateGroundedText ?? notImplemented,
    },
    openrouter: { generateJson: overrides.openrouter?.generateJson ?? notImplemented },
  }
}

const PASSING_JUDGE_RESPONSE = {
  still_discounted: true,
  fresh_price_low: 9500,
  fresh_price_high: 10500,
  condition_explains_low_price: false,
  meets_profit_bar: true,
  reasoning: 'Fresh secondhand market ~₱10k; minor cosmetic wear does not explain a ₱6.5k ask.',
}

test('buildPriceQuery asks for a secondhand price for a "Used - like new" condition, not retail', () => {
  // Regression: "Used - like new" contains "new" but is never actually
  // new-in-box - used to get misread as a New condition and priced against
  // brand-new retail instead of the secondhand market.
  const query = buildPriceQuery(candidate({ condition: 'Used - like new' }))

  expect(query).toContain('current secondhand/resale price')
  expect(query).not.toContain('current retail price')
})

test('buildPriceQuery asks for a secondhand price for ordinary used conditions', () => {
  expect(buildPriceQuery(candidate({ condition: 'Used - Good' }))).toContain('current secondhand/resale price')
  expect(buildPriceQuery(candidate({ condition: 'Used - Fair' }))).toContain('current secondhand/resale price')
})

test('buildPriceQuery asks for a retail price only for a genuinely new (not "used") condition', () => {
  expect(buildPriceQuery(candidate({ condition: 'New' }))).toContain('current retail price')
  expect(buildPriceQuery(candidate({ condition: 'Brand New' }))).toContain('current retail price')
})

test('buildPriceQuery treats a null condition as secondhand (safer default, not retail)', () => {
  expect(buildPriceQuery(candidate({ condition: null }))).toContain('current secondhand/resale price')
})

test('buildPriceQuery appends title/description as a spec hint when base_model is too generic to price alone', () => {
  // Regression: bare "HP Laptop"/"Desktop" pulled pricing for far stronger
  // configs than the actual budget unit - title/description usually still
  // carry the real spec (CPU/RAM/storage) that extraction stripped out of
  // base_model.
  const query = buildPriceQuery(
    candidate({
      base_model: 'HP Laptop',
      title: 'Rush sale HP laptop Intel Celeron 8gb ram 128gb SSD',
      description: 'good keyboard LCD camera, speaker needs drivers',
    }),
  )

  expect(query).toContain('HP Laptop')
  expect(query).toContain('Intel Celeron 8gb ram 128gb SSD')
  expect(query).toContain('speaker needs drivers')
})

test('buildPriceQuery falls back to bare base_model when title and description are both null', () => {
  const query = buildPriceQuery(candidate({ base_model: 'HP Laptop', title: null, description: null }))

  expect(query).toBe('current secondhand/resale price of HP Laptop in the Philippines')
})

test('buildPriceQuery truncates an overly long spec hint rather than sending an unbounded query', () => {
  const longDescription = 'x'.repeat(500)
  const query = buildPriceQuery(candidate({ title: null, description: longDescription }))

  expect(query.length).toBeLessThan(300)
})

test('precheckDiscountCandidate: price below the floor rejects, synchronously', () => {
  expect(precheckDiscountCandidate(candidate({ price_amount: 100 }))).toEqual({
    outcome: 'rejected',
    reasoning: 'Asking price below the ₱500 floor - not worth chasing regardless of discount math.',
  })
})

test('precheckDiscountCandidate: non-specific product rejects, synchronously', () => {
  expect(precheckDiscountCandidate(candidate({ is_specific_product: false }))).toEqual({
    outcome: 'rejected',
    reasoning: 'Product is not a specific, priceable item.',
  })
})

test('precheckDiscountCandidate: unenriched product is pending, synchronously', () => {
  expect(precheckDiscountCandidate(candidate({ is_specific_product: null }))).toEqual({
    outcome: 'pending',
    reasoning: 'Product enrichment not yet available.',
  })
})

test('precheckDiscountCandidate: a priced, specific product proceeds', () => {
  expect(precheckDiscountCandidate(candidate())).toEqual({ outcome: 'proceed' })
})

test('price below the ₱500 floor rejects immediately, no client calls made, even for a specific product', async () => {
  const clients = fakeClients({})

  const result = await verifyDiscountCandidate(candidate({ price_amount: 100, is_specific_product: true }), clients)

  expect(result.outcome).toBe('rejected')
})

test('price at exactly the ₱500 floor is not rejected by the price gate', async () => {
  const clients = fakeClients({
    exa: { searchStructured: async () => ({ output: { content: { summary: 'context' } } }) },
    openrouter: { generateJson: async () => PASSING_JUDGE_RESPONSE },
  })

  const result = await verifyDiscountCandidate(candidate({ price_amount: 500 }), clients)

  expect(result.outcome).toBe('verified')
})

test('is_specific_product false rejects immediately, no client calls made', async () => {
  const clients = fakeClients({})

  const result = await verifyDiscountCandidate(candidate({ is_specific_product: false }), clients)

  expect(result.outcome).toBe('rejected')
})

test('is_specific_product null (enrichment not run yet) leaves it pending, no client calls made', async () => {
  const clients = fakeClients({})

  const result = await verifyDiscountCandidate(candidate({ is_specific_product: null }), clients)

  expect(result.outcome).toBe('pending')
})

test('Exa answer is used when available, Tavily/Gemini never called', async () => {
  let tavilyCalled = false
  let geminiCalled = false
  const clients = fakeClients({
    exa: {
      searchStructured: async () => ({ output: { content: { summary: 'Typical secondhand price PHP 9,500-10,500' } } }),
    },
    tavily: {
      search: async () => {
        tavilyCalled = true
        return { answer: null, results: [] }
      },
    },
    gemini: {
      generateGroundedText: async () => {
        geminiCalled = true
        return ''
      },
    },
    openrouter: { generateJson: async () => PASSING_JUDGE_RESPONSE },
  })

  const result = await verifyDiscountCandidate(candidate(), clients)

  expect(result.outcome).toBe('verified')
  if (result.outcome === 'verified') expect(result.source).toBe('exa')
  expect(tavilyCalled).toBe(false)
  expect(geminiCalled).toBe(false)
})

test('empty Exa result (no summary) falls through to Tavily', async () => {
  const clients = fakeClients({
    exa: { searchStructured: async () => ({ output: { content: {} } }) },
    tavily: { search: async () => ({ answer: 'Secondhand ~10k on Carousell', results: [] }) },
    openrouter: { generateJson: async () => PASSING_JUDGE_RESPONSE },
  })

  const result = await verifyDiscountCandidate(candidate(), clients)

  expect(result.outcome).toBe('verified')
  if (result.outcome === 'verified') expect(result.source).toBe('tavily')
})

test('Exa throwing falls through to Tavily', async () => {
  const clients = fakeClients({
    exa: {
      searchStructured: async () => {
        throw new Error('exa down')
      },
    },
    tavily: { search: async () => ({ answer: 'Secondhand ~10k', results: [] }) },
    openrouter: { generateJson: async () => PASSING_JUDGE_RESPONSE },
  })

  const result = await verifyDiscountCandidate(candidate(), clients)

  expect(result.outcome).toBe('verified')
  if (result.outcome === 'verified') expect(result.source).toBe('tavily')
})

test('Exa and Tavily both empty/erroring falls through to Gemini grounding', async () => {
  const clients = fakeClients({
    exa: {
      searchStructured: async () => {
        throw new Error('exa down')
      },
    },
    tavily: { search: async () => ({ answer: null, results: [] }) },
    gemini: { generateGroundedText: async () => 'Secondhand market is around PHP 10,000.' },
    openrouter: { generateJson: async () => PASSING_JUDGE_RESPONSE },
  })

  const result = await verifyDiscountCandidate(candidate(), clients)

  expect(result.outcome).toBe('verified')
  if (result.outcome === 'verified') expect(result.source).toBe('gemini_grounding')
})

test('all three price providers empty/erroring leaves the candidate pending', async () => {
  const clients = fakeClients({
    exa: {
      searchStructured: async () => {
        throw new Error('exa down')
      },
    },
    tavily: { search: async () => ({ answer: null, results: [] }) },
    gemini: {
      generateGroundedText: async () => {
        throw new Error('gemini down')
      },
    },
  })

  const result = await verifyDiscountCandidate(candidate(), clients)

  expect(result.outcome).toBe('pending')
})

test('verified outcome derives discountPercent/referencePrice from the fresh price, not the stale one', async () => {
  const clients = fakeClients({
    tavily: { search: async () => ({ answer: 'ok', results: [] }) },
    openrouter: { generateJson: async () => PASSING_JUDGE_RESPONSE },
  })

  const result = await verifyDiscountCandidate(candidate({ price_amount: 6500 }), clients)

  expect(result.outcome).toBe('verified')
  if (result.outcome === 'verified') {
    expect(result.referencePrice).toBe(9500)
    expect(result.discountPercent).toBe(32) // round((9500-6500)/9500*100)
  }
})

test('DeepSeek saying still_discounted=false rejects', async () => {
  const clients = fakeClients({
    tavily: { search: async () => ({ answer: 'ok', results: [] }) },
    openrouter: { generateJson: async () => ({ ...PASSING_JUDGE_RESPONSE, still_discounted: false }) },
  })

  const result = await verifyDiscountCandidate(candidate(), clients)

  expect(result.outcome).toBe('rejected')
})

test('DeepSeek saying condition_explains_low_price=true rejects (defects explain the price, not a real bargain)', async () => {
  const clients = fakeClients({
    tavily: { search: async () => ({ answer: 'ok', results: [] }) },
    openrouter: { generateJson: async () => ({ ...PASSING_JUDGE_RESPONSE, condition_explains_low_price: true }) },
  })

  const result = await verifyDiscountCandidate(candidate(), clients)

  expect(result.outcome).toBe('rejected')
})

test('DeepSeek saying meets_profit_bar=false rejects', async () => {
  const clients = fakeClients({
    tavily: { search: async () => ({ answer: 'ok', results: [] }) },
    openrouter: { generateJson: async () => ({ ...PASSING_JUDGE_RESPONSE, meets_profit_bar: false }) },
  })

  const result = await verifyDiscountCandidate(candidate(), clients)

  expect(result.outcome).toBe('rejected')
})

test('DeepSeek throwing leaves the candidate pending, not rejected', async () => {
  const clients = fakeClients({
    tavily: { search: async () => ({ answer: 'ok', results: [] }) },
    openrouter: {
      generateJson: async () => {
        throw new Error('openrouter down')
      },
    },
  })

  const result = await verifyDiscountCandidate(candidate(), clients)

  expect(result.outcome).toBe('pending')
})

test('a malformed DeepSeek response (missing required fields) leaves the candidate pending, not rejected', async () => {
  const clients = fakeClients({
    tavily: { search: async () => ({ answer: 'ok', results: [] }) },
    openrouter: { generateJson: async () => ({ reasoning: 'incomplete' }) },
  })

  const result = await verifyDiscountCandidate(candidate(), clients)

  expect(result.outcome).toBe('pending')
})

describe('runVerifyDiscountNotifications', () => {
  const LOG_PATH = 'data/tmp-verify-discount-notifications.log'

  afterEach(() => {
    if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
  })

  function notImplemented(): never {
    throw new Error('not implemented in this fake')
  }

  function fakeClients(
    overrides: Partial<{ tavilyAnswer: string | null; openrouterResponse: unknown }>,
  ): VerificationClients {
    const tavilyAnswer = 'tavilyAnswer' in overrides ? overrides.tavilyAnswer! : 'Fresh market ~₱10,000'
    return {
      tavily: { search: async () => ({ answer: tavilyAnswer, results: [] }) },
      exa: { searchStructured: notImplemented },
      gemini: { generateJson: notImplemented, generateGroundedText: notImplemented },
      openrouter: {
        generateJson: async () =>
          overrides.openrouterResponse ?? {
            still_discounted: true,
            fresh_price_low: 9500,
            fresh_price_high: 10500,
            condition_explains_low_price: false,
            meets_profit_bar: true,
            reasoning: 'Genuine deal.',
          },
      },
    }
  }

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

  function candidate(overrides: Partial<DiscountVerificationCandidate> = {}): DiscountVerificationCandidate {
    return {
      id: 7,
      listing_id: '123',
      title: 'Sony WH-1000XM5',
      description: 'Used, minor scuff, battery great',
      condition: 'Used - Good',
      price_amount: 6500,
      base_model: 'Sony WH-1000XM5',
      is_specific_product: true,
      ...overrides,
    }
  }

  test('a verified candidate writes the fresh numbers via markDiscountNotificationVerified', async () => {
    const clients = fakeClients({})
    const { db, calls } = fakeDb()
    const logger = createLogger(LOG_PATH)

    await runVerifyDiscountNotifications({ clients, db, logger }, [candidate()])

    const updateCall = calls.find((c) => c.sql.includes('verified_at = now()'))
    expect(updateCall).toBeDefined()
    expect(updateCall!.params).toEqual([7, 32, 9500, 'tavily', 'Genuine deal.'])
  })

  test('a rejected candidate is deleted', async () => {
    const clients = fakeClients({
      openrouterResponse: {
        still_discounted: false,
        fresh_price_low: 9500,
        fresh_price_high: 10500,
        condition_explains_low_price: false,
        meets_profit_bar: true,
        reasoning: 'Not actually discounted.',
      },
    })
    const { db, calls } = fakeDb()
    const logger = createLogger(LOG_PATH)

    await runVerifyDiscountNotifications({ clients, db, logger }, [candidate()])

    const deleteCall = calls.find((c) => c.sql.startsWith('DELETE FROM discount_notifications'))
    expect(deleteCall).toBeDefined()
    expect(deleteCall!.params).toEqual([7])
  })

  test('a pending candidate (no fresh data) bumps last_verification_attempt_at, does not verify or delete', async () => {
    const clients = fakeClients({ tavilyAnswer: null })
    const { db, calls } = fakeDb()
    const logger = createLogger(LOG_PATH)

    await runVerifyDiscountNotifications({ clients, db, logger }, [candidate()])

    const attemptCall = calls.find((c) => c.sql.includes('last_verification_attempt_at = now()'))
    expect(attemptCall).toBeDefined()
    expect(attemptCall!.params).toEqual([7])
    expect(calls.some((c) => c.sql.includes('verified_at = now()'))).toBe(false)
    expect(calls.some((c) => c.sql.startsWith('DELETE'))).toBe(false)
  })

  test('free rejections/pending are processed for the whole batch even when the paid budget is 0', async () => {
    const clients: VerificationClients = {
      tavily: { search: notImplemented },
      exa: { searchStructured: notImplemented },
      gemini: { generateJson: notImplemented, generateGroundedText: notImplemented },
      openrouter: { generateJson: notImplemented },
    }
    const { db, calls } = fakeDb()
    const logger = createLogger(LOG_PATH)

    await runVerifyDiscountNotifications(
      { clients, db, logger },
      [
        candidate({ id: 1, listing_id: 'a', price_amount: 100 }), // free reject (price floor)
        candidate({ id: 2, listing_id: 'b', is_specific_product: false }), // free reject (non-specific)
        candidate({ id: 3, listing_id: 'c', is_specific_product: null }), // free pending (enrichment)
      ],
      { paidLimit: 0 }, // no paid budget at all this lap
    )

    // None of these ever touch a client - proven by notImplemented() never throwing.
    const deleteCalls = calls.filter((c) => c.sql.startsWith('DELETE FROM discount_notifications'))
    expect(deleteCalls.map((c) => c.params)).toEqual([[1], [2]])
    const attemptCalls = calls.filter((c) => c.sql.includes('last_verification_attempt_at = now()'))
    expect(attemptCalls.map((c) => c.params)).toEqual([[3]])
  })

  test('a paid-eligible candidate beyond the budget is left completely untouched, retried unpenalized next lap', async () => {
    const clients = fakeClients({})
    const { db, calls } = fakeDb()
    const logger = createLogger(LOG_PATH)

    await runVerifyDiscountNotifications(
      { clients, db, logger },
      [candidate({ id: 1, listing_id: 'a' }), candidate({ id: 2, listing_id: 'b' })],
      { paidLimit: 1 }, // only 1 paid call allowed this lap
    )

    // Candidate 1 gets the budget and verifies; candidate 2 is untouched - no
    // attempt/reject/verify call for it at all.
    const verifiedCall = calls.find((c) => c.sql.includes('verified_at = now()'))
    expect(verifiedCall!.params).toEqual([1, 32, 9500, 'tavily', 'Genuine deal.'])
    expect(calls.some((c) => c.params[0] === 2)).toBe(false)
  })

  test('one candidate throwing unexpectedly is logged and skipped, not fatal to the rest', async () => {
    const clients: VerificationClients = {
      tavily: {
        search: async () => {
          throw new Error('boom')
        },
      },
      exa: { searchStructured: notImplemented },
      gemini: {
        generateJson: notImplemented,
        generateGroundedText: async () => {
          throw new Error('boom')
        },
      },
      openrouter: { generateJson: notImplemented },
    }
    const { db, calls } = fakeDb()
    const logger = createLogger(LOG_PATH)

    // verifyDiscountCandidate itself never throws (fails closed to 'pending'),
    // so this exercises the same path as the "no fresh data" test above, just
    // confirming the loop processes every candidate given, not just the first.
    await runVerifyDiscountNotifications({ clients, db, logger }, [
      candidate({ id: 1, listing_id: 'a' }),
      candidate({ id: 2, listing_id: 'b' }),
    ])

    const attemptCalls = calls.filter((c) => c.sql.includes('last_verification_attempt_at = now()'))
    expect(attemptCalls.map((c) => c.params)).toEqual([[1], [2]])
  })
})
