import type { GroqClient } from './groq'
import { isQuotaError, createFallbackGroqClient } from './groq'

// createGroqClient itself wraps the real SDK and is not unit tested here —
// same precedent as createGeminiClient/createDbPool elsewhere in this repo.
// This test just locks down the GroqClient shape the rest of the pipeline
// is built against.
test('a GroqClient exposes generateJson(prompt, schema) returning parsed data', async () => {
  const client: GroqClient = {
    generateJson: async () => ({ results: [{ id: '1', description: 'x' }] }),
  }
  const result = await client.generateJson('some prompt', { type: 'object' })
  expect(result).toEqual({ results: [{ id: '1', description: 'x' }] })
})

test('isQuotaError is true only for an error with status 429', () => {
  const quotaErr = new Error('rate limited') as Error & { status: number }
  quotaErr.status = 429
  expect(isQuotaError(quotaErr)).toBe(true)

  const otherErr = new Error('bad request') as Error & { status: number }
  otherErr.status = 400
  expect(isQuotaError(otherErr)).toBe(false)

  expect(isQuotaError(new Error('plain error'))).toBe(false)
  expect(isQuotaError('not an object')).toBe(false)
})

test('fallback client uses the primary until it hits a quota error, then switches permanently to the next one', async () => {
  let primaryCalls = 0
  let secondaryCalls = 0
  const primary: GroqClient = {
    generateJson: async () => {
      primaryCalls += 1
      if (primaryCalls === 2) {
        const err = new Error('quota exceeded') as Error & { status: number }
        err.status = 429
        throw err
      }
      return { results: [{ id: '1', from: 'primary' }] }
    },
  }
  const secondary: GroqClient = {
    generateJson: async () => {
      secondaryCalls += 1
      return { results: [{ id: '1', from: 'secondary' }] }
    },
  }
  const client = createFallbackGroqClient([primary, secondary])

  await client.generateJson('p1', {}) // primary succeeds
  await client.generateJson('p2', {}) // primary 429s -> falls back to secondary mid-call
  await client.generateJson('p3', {}) // goes straight to secondary now, no retry of primary

  expect(primaryCalls).toBe(2)
  expect(secondaryCalls).toBe(2)
})

test('fallback client rethrows non-quota errors without switching', async () => {
  let primaryCalls = 0
  const primary: GroqClient = {
    generateJson: async () => {
      primaryCalls += 1
      throw new Error('some other failure')
    },
  }
  const secondary: GroqClient = {
    generateJson: async () => {
      throw new Error('should never be called')
    },
  }
  const client = createFallbackGroqClient([primary, secondary])

  await expect(client.generateJson('p', {})).rejects.toThrow('some other failure')
  expect(primaryCalls).toBe(1)
})

test('fallback client rethrows the quota error once every client is exhausted', async () => {
  const exhausted: GroqClient = {
    generateJson: async () => {
      const err = new Error('quota exceeded') as Error & { status: number }
      err.status = 429
      throw err
    },
  }
  const client = createFallbackGroqClient([exhausted, exhausted])

  await expect(client.generateJson('p', {})).rejects.toThrow('quota exceeded')
})
