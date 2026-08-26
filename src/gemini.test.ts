import type { GeminiClient } from './gemini'
import { createFallbackGeminiClient } from './gemini'

function quotaError(): Error & { status: number } {
  const err = new Error('quota exceeded') as Error & { status: number }
  err.status = 429
  return err
}

function notImplemented(): never {
  throw new Error('not implemented in this fake')
}

// createGeminiClient itself wraps the real SDK and is not unit tested here —
// same precedent as createDbPool/createR2ImageStore/launchBrowser elsewhere
// in this repo. These tests just lock down the GeminiClient shape the rest
// of the pipeline is built against.
function fakeGeminiClient(overrides: Partial<GeminiClient>): GeminiClient {
  return {
    generateJson: overrides.generateJson ?? notImplemented,
    generateGroundedText: overrides.generateGroundedText ?? notImplemented,
  }
}

test('a GeminiClient exposes generateJson(prompt, schema) returning parsed data', async () => {
  const client = fakeGeminiClient({ generateJson: async () => [{ id: '1', base_model: 'RTX 3060' }] })
  const result = await client.generateJson('some prompt', { type: 'array' })
  expect(result).toEqual([{ id: '1', base_model: 'RTX 3060' }])
})

test('a GeminiClient exposes generateGroundedText(prompt) returning raw text', async () => {
  const client = fakeGeminiClient({ generateGroundedText: async () => 'PRICE_RANGE: 4500-12000 PHP' })
  const result = await client.generateGroundedText('some prompt')
  expect(result).toBe('PRICE_RANGE: 4500-12000 PHP')
})

test('fallback client uses the primary until it hits a quota error, then switches permanently to the next one', async () => {
  let primaryCalls = 0
  let secondaryCalls = 0
  const primary = fakeGeminiClient({
    generateJson: async () => {
      primaryCalls += 1
      if (primaryCalls === 2) throw quotaError()
      return [{ id: '1', base_model: 'A' }]
    },
  })
  const secondary = fakeGeminiClient({
    generateJson: async () => {
      secondaryCalls += 1
      return [{ id: '1', base_model: 'B' }]
    },
  })
  const client = createFallbackGeminiClient([primary, secondary])

  await client.generateJson('p1', {}) // primary succeeds
  await client.generateJson('p2', {}) // primary 429s -> falls back to secondary mid-call
  await client.generateJson('p3', {}) // goes straight to secondary now, no retry of primary

  expect(primaryCalls).toBe(2)
  expect(secondaryCalls).toBe(2)
})

test('fallback client rethrows non-quota errors without switching', async () => {
  let primaryCalls = 0
  const primary = fakeGeminiClient({
    generateJson: async () => {
      primaryCalls += 1
      throw new Error('some other failure')
    },
  })
  const secondary = fakeGeminiClient({
    generateJson: async () => {
      throw new Error('should never be called')
    },
  })
  const client = createFallbackGeminiClient([primary, secondary])

  await expect(client.generateJson('p', {})).rejects.toThrow('some other failure')
  expect(primaryCalls).toBe(1)
})

test('fallback client rethrows the quota error once every client is exhausted', async () => {
  const exhausted = fakeGeminiClient({
    generateJson: async () => {
      throw quotaError()
    },
  })
  const client = createFallbackGeminiClient([exhausted, exhausted])

  await expect(client.generateJson('p', {})).rejects.toThrow('quota exceeded')
})

test('fallback client applies the same quota-fallback behavior to generateGroundedText, sharing the cursor with generateJson', async () => {
  let primaryTextCalls = 0
  let secondaryTextCalls = 0
  const primary = fakeGeminiClient({
    generateGroundedText: async () => {
      primaryTextCalls += 1
      throw quotaError()
    },
  })
  const secondary = fakeGeminiClient({
    generateGroundedText: async () => {
      secondaryTextCalls += 1
      return 'PRICE_RANGE: 100-200 PHP'
    },
  })
  const client = createFallbackGeminiClient([primary, secondary])

  const result = await client.generateGroundedText('p')

  expect(result).toBe('PRICE_RANGE: 100-200 PHP')
  expect(primaryTextCalls).toBe(1)
  expect(secondaryTextCalls).toBe(1)
})
