import type { AnthropicClient } from './anthropic'
import { createFallbackAnthropicClient, isAnthropicRateLimitError } from './anthropic'

function rateLimitError(): Error & { status: number } {
  const err = new Error('rate limited') as Error & { status: number }
  err.status = 429
  return err
}

function notImplemented(): never {
  throw new Error('not implemented in this fake')
}

function fakeAnthropicClient(overrides: Partial<AnthropicClient>): AnthropicClient {
  return {
    searchStructured: overrides.searchStructured ?? notImplemented,
  }
}

// createAnthropicClient itself wraps the real @anthropic-ai/sdk call and is
// not unit tested here — same precedent as createExaClient/createGeminiClient
// elsewhere in this repo.
test('isAnthropicRateLimitError only matches an error with status 429', () => {
  expect(isAnthropicRateLimitError(rateLimitError())).toBe(true)
  expect(isAnthropicRateLimitError(new Error('some other failure'))).toBe(false)
  expect(isAnthropicRateLimitError(null)).toBe(false)
})

test('fallback client uses the primary until it hits a 429 rate-limit error, then switches permanently', async () => {
  let primaryCalls = 0
  let secondaryCalls = 0
  const primary = fakeAnthropicClient({
    searchStructured: async () => {
      primaryCalls += 1
      if (primaryCalls === 2) throw rateLimitError()
      return { content: [] }
    },
  })
  const secondary = fakeAnthropicClient({
    searchStructured: async () => {
      secondaryCalls += 1
      return { content: [{ type: 'text', text: 'from secondary' }] }
    },
  })
  const client = createFallbackAnthropicClient([primary, secondary])

  await client.searchStructured('q1', 's', {}) // primary succeeds
  await client.searchStructured('q2', 's', {}) // primary 429s -> falls back mid-call
  await client.searchStructured('q3', 's', {}) // goes straight to secondary now

  expect(primaryCalls).toBe(2)
  expect(secondaryCalls).toBe(2)
})

test('fallback client rethrows non-rate-limit errors without switching', async () => {
  let primaryCalls = 0
  const primary = fakeAnthropicClient({
    searchStructured: async () => {
      primaryCalls += 1
      throw new Error('some other failure')
    },
  })
  const secondary = fakeAnthropicClient({
    searchStructured: async () => {
      throw new Error('should never be called')
    },
  })
  const client = createFallbackAnthropicClient([primary, secondary])

  await expect(client.searchStructured('q', 's', {})).rejects.toThrow('some other failure')
  expect(primaryCalls).toBe(1)
})

test('fallback client rethrows the rate-limit error once every client is exhausted', async () => {
  const exhausted = fakeAnthropicClient({
    searchStructured: async () => {
      throw rateLimitError()
    },
  })
  const client = createFallbackAnthropicClient([exhausted, exhausted])

  await expect(client.searchStructured('q', 's', {})).rejects.toThrow('rate limited')
})
