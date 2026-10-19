import { verifyDiscountCandidate } from './discount-verification'
import type { DiscountVerificationCandidate } from '../types'
import type { TavilyClient, ExaClient, GeminiClient, OpenRouterClient } from '../../../platform/llm-clients'

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
