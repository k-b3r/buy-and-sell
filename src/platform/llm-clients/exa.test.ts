import type { ExaClient } from './exa'
import { createFallbackExaClient, loadExaApiKeys } from './exa'

function creditsExhaustedError(): Error & { status: number } {
  const err = new Error(
    'Exa request failed: 402 {"error":"You have exceeded your credits limit. Please top up to keep using Exa at dashboard.exa.ai","tag":"NO_MORE_CREDITS"}',
  ) as Error & { status: number }
  err.status = 402
  return err
}

function notImplemented(): never {
  throw new Error('not implemented in this fake')
}

function fakeExaClient(overrides: Partial<ExaClient>): ExaClient {
  return {
    searchStructured: overrides.searchStructured ?? notImplemented,
  }
}

test('loadExaApiKeys reads EXA_API_KEY0.. sequentially, stopping at the first gap', () => {
  expect(loadExaApiKeys({ EXA_API_KEY0: 'a', EXA_API_KEY1: 'b', EXA_API_KEY2: 'c' })).toEqual(['a', 'b', 'c'])
})

test('loadExaApiKeys stops at a gap even if a later index is set (no gap-filling)', () => {
  expect(loadExaApiKeys({ EXA_API_KEY0: 'a', EXA_API_KEY2: 'c' })).toEqual(['a'])
})

test('loadExaApiKeys returns an empty array when none are set', () => {
  expect(loadExaApiKeys({})).toEqual([])
})

test('loadExaApiKeys ignores the old fixed-name scheme (EXA_API_KEY/ALT_EXA_API_KEY)', () => {
  expect(loadExaApiKeys({ EXA_API_KEY: 'old', ALT_EXA_API_KEY: 'old-alt' })).toEqual([])
})

// createExaClient itself wraps the real fetch call to api.exa.ai and is not
// unit tested here — same precedent as createGroqClient/createGeminiClient
// elsewhere in this repo. This test just locks down the ExaClient shape the
// rest of the pipeline is built against.
test('an ExaClient exposes searchStructured(query, systemPrompt, schema) returning the full Exa response', async () => {
  const client: ExaClient = {
    searchStructured: async () => ({
      output: { content: { found: true, price_low: 1, price_high: 2 }, grounding: [] },
      results: [],
    }),
  }
  const result = await client.searchStructured('some query', 'some system prompt', { type: 'object' })
  expect(result).toEqual({
    output: { content: { found: true, price_low: 1, price_high: 2 }, grounding: [] },
    results: [],
  })
})

test('fallback client uses the primary until it hits a 402 credits-exhausted error, then switches permanently', async () => {
  let primaryCalls = 0
  let secondaryCalls = 0
  const primary = fakeExaClient({
    searchStructured: async () => {
      primaryCalls += 1
      if (primaryCalls === 2) throw creditsExhaustedError()
      return { output: { content: { found: true } } }
    },
  })
  const secondary = fakeExaClient({
    searchStructured: async () => {
      secondaryCalls += 1
      return { output: { content: { found: true, source: 'secondary' } } }
    },
  })
  const client = createFallbackExaClient([primary, secondary])

  await client.searchStructured('q1', 's', {}) // primary succeeds
  await client.searchStructured('q2', 's', {}) // primary 402s -> falls back mid-call
  await client.searchStructured('q3', 's', {}) // goes straight to secondary now

  expect(primaryCalls).toBe(2)
  expect(secondaryCalls).toBe(2)
})

test('fallback client rethrows non-credits errors without switching', async () => {
  let primaryCalls = 0
  const primary = fakeExaClient({
    searchStructured: async () => {
      primaryCalls += 1
      throw new Error('some other failure')
    },
  })
  const secondary = fakeExaClient({
    searchStructured: async () => {
      throw new Error('should never be called')
    },
  })
  const client = createFallbackExaClient([primary, secondary])

  await expect(client.searchStructured('q', 's', {})).rejects.toThrow('some other failure')
  expect(primaryCalls).toBe(1)
})

test('fallback client rethrows the credits error once every client is exhausted', async () => {
  const exhausted = fakeExaClient({
    searchStructured: async () => {
      throw creditsExhaustedError()
    },
  })
  const client = createFallbackExaClient([exhausted, exhausted])

  await expect(client.searchStructured('q', 's', {})).rejects.toThrow('credits limit')
})
