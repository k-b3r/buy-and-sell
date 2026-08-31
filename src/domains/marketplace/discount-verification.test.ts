import { verifyDiscountCandidate, buildPriceQuery } from './discount-verification'
import type { DiscountVerificationCandidate } from './storage/listings'
import type { TavilyClient, ExaClient, GeminiClient, OpenRouterClient } from '../llm-clients'

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
    exa: { searchStructured: async () => ({ output: { content: { summary: 'Typical secondhand price PHP 9,500-10,500' } } }) },
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
