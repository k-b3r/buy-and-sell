import type { OpenRouterClient } from './openrouter'
import { isQuotaError, createFallbackOpenRouterClient } from './openrouter'

// createOpenRouterClient itself wraps the real fetch call to openrouter.ai
// and is not unit tested here — same precedent as createGroqClient/
// createExaClient elsewhere in this repo. This test just locks down the
// OpenRouterClient shape the rest of the pipeline is built against.
test('an OpenRouterClient exposes generateJson(prompt, schema) returning parsed data', async () => {
  const client: OpenRouterClient = {
    generateJson: async () => ({ still_discounted: true }),
  }
  const result = await client.generateJson('some prompt', { type: 'object' })
  expect(result).toEqual({ still_discounted: true })
})

test('isQuotaError is true for a 429 rate-limit or a 402 insufficient-credits error', () => {
  const rateLimited = new Error('rate limited') as Error & { status: number }
  rateLimited.status = 429
  expect(isQuotaError(rateLimited)).toBe(true)

  const noCredits = new Error('insufficient credits') as Error & { status: number }
  noCredits.status = 402
  expect(isQuotaError(noCredits)).toBe(true)

  const badRequest = new Error('bad request') as Error & { status: number }
  badRequest.status = 400
  expect(isQuotaError(badRequest)).toBe(false)

  expect(isQuotaError(new Error('plain error'))).toBe(false)
  expect(isQuotaError('not an object')).toBe(false)
})

test('fallback client uses the primary until it hits a quota error, then switches permanently to the next one', async () => {
  let primaryCalls = 0
  let secondaryCalls = 0
  const primary: OpenRouterClient = {
    generateJson: async () => {
      primaryCalls += 1
      if (primaryCalls === 2) {
        const err = new Error('quota exceeded') as Error & { status: number }
        err.status = 429
        throw err
      }
      return { from: 'primary' }
    },
  }
  const secondary: OpenRouterClient = {
    generateJson: async () => {
      secondaryCalls += 1
      return { from: 'secondary' }
    },
  }
  const client = createFallbackOpenRouterClient([primary, secondary])

  await client.generateJson('p1', {}) // primary succeeds
  await client.generateJson('p2', {}) // primary 429s -> falls back to secondary mid-call
  await client.generateJson('p3', {}) // goes straight to secondary now, no retry of primary

  expect(primaryCalls).toBe(2)
  expect(secondaryCalls).toBe(2)
})

test('fallback client rethrows non-quota errors without switching', async () => {
  let primaryCalls = 0
  const primary: OpenRouterClient = {
    generateJson: async () => {
      primaryCalls += 1
      throw new Error('some other failure')
    },
  }
  const secondary: OpenRouterClient = {
    generateJson: async () => {
      throw new Error('should never be called')
    },
  }
  const client = createFallbackOpenRouterClient([primary, secondary])

  await expect(client.generateJson('p', {})).rejects.toThrow('some other failure')
  expect(primaryCalls).toBe(1)
})

test('fallback client rethrows the quota error once every client is exhausted', async () => {
  const exhausted: OpenRouterClient = {
    generateJson: async () => {
      const err = new Error('quota exceeded') as Error & { status: number }
      err.status = 429
      throw err
    },
  }
  const client = createFallbackOpenRouterClient([exhausted, exhausted])

  await expect(client.generateJson('p', {})).rejects.toThrow('quota exceeded')
})
