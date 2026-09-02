import type { GeminiClient } from './gemini'
import { createFallbackGeminiClient, createDailyGroundingCap, createQuotaAwareGeminiClient } from './gemini'

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

test('createDailyGroundingCap passes generateGroundedText through under the limit', async () => {
  const inner = fakeGeminiClient({ generateGroundedText: async () => 'PRICE_RANGE: 100-200 PHP' })
  const client = createDailyGroundingCap(inner, 2)

  expect(await client.generateGroundedText('p')).toBe('PRICE_RANGE: 100-200 PHP')
})

test('createDailyGroundingCap refuses further grounded calls once the daily limit is reached', async () => {
  let calls = 0
  const inner = fakeGeminiClient({
    generateGroundedText: async () => {
      calls += 1
      return 'ok'
    },
  })
  const client = createDailyGroundingCap(inner, 2)

  await client.generateGroundedText('p1')
  await client.generateGroundedText('p2')
  await expect(client.generateGroundedText('p3')).rejects.toThrow('daily cap (2) reached')

  expect(calls).toBe(2)
})

test('createDailyGroundingCap resets the count on a new day (Pacific time)', async () => {
  let calls = 0
  const inner = fakeGeminiClient({
    generateGroundedText: async () => {
      calls += 1
      return 'ok'
    },
  })
  let today = new Date('2026-08-31T12:00:00-07:00') // noon Pacific
  const client = createDailyGroundingCap(inner, 1, () => today)

  await client.generateGroundedText('p1')
  await expect(client.generateGroundedText('p2')).rejects.toThrow('daily cap')

  today = new Date('2026-09-01T12:00:00-07:00') // next day, Pacific
  await client.generateGroundedText('p3') // allowed again

  expect(calls).toBe(2)
})

test('createDailyGroundingCap does not limit generateJson (a different, unmetered pricing bucket)', async () => {
  let jsonCalls = 0
  const inner = fakeGeminiClient({
    generateJson: async () => {
      jsonCalls += 1
      return { ok: true }
    },
    generateGroundedText: async () => 'ok',
  })
  const client = createDailyGroundingCap(inner, 0) // grounded calls always refused

  await client.generateJson('p', {})
  await client.generateJson('p', {})

  expect(jsonCalls).toBe(2)
})

test('createDailyGroundingCap defaults to a 1000/day limit, a buffer under Google\'s real 1500/day ceiling', async () => {
  let calls = 0
  const inner = fakeGeminiClient({
    generateGroundedText: async () => {
      calls += 1
      return 'ok'
    },
  })
  const client = createDailyGroundingCap(inner)

  for (let i = 0; i < 1000; i++) await client.generateGroundedText('p')
  await expect(client.generateGroundedText('p')).rejects.toThrow('daily cap (1000) reached')

  expect(calls).toBe(1000)
})

test('createQuotaAwareGeminiClient passes calls through normally before any quota error', async () => {
  const inner = fakeGeminiClient({ generateGroundedText: async () => 'PRICE_RANGE: 100-200 PHP' })
  const client = createQuotaAwareGeminiClient(inner)

  expect(await client.generateGroundedText('p')).toBe('PRICE_RANGE: 100-200 PHP')
})

test('createQuotaAwareGeminiClient short-circuits later same-day calls after a 429, without hitting the inner client again', async () => {
  let calls = 0
  const inner = fakeGeminiClient({
    generateGroundedText: async () => {
      calls += 1
      throw quotaError()
    },
  })
  const client = createQuotaAwareGeminiClient(inner)

  await expect(client.generateGroundedText('p1')).rejects.toThrow('quota exceeded')
  await expect(client.generateGroundedText('p2')).rejects.toThrow('already confirmed exhausted')

  expect(calls).toBe(1)
})

test('createQuotaAwareGeminiClient does not short-circuit a non-quota error', async () => {
  let calls = 0
  const inner = fakeGeminiClient({
    generateGroundedText: async () => {
      calls += 1
      throw new Error('some other failure')
    },
  })
  const client = createQuotaAwareGeminiClient(inner)

  await expect(client.generateGroundedText('p1')).rejects.toThrow('some other failure')
  await expect(client.generateGroundedText('p2')).rejects.toThrow('some other failure')

  expect(calls).toBe(2)
})

test('createQuotaAwareGeminiClient resets the exhausted flag on a new day (Pacific time)', async () => {
  let calls = 0
  const inner = fakeGeminiClient({
    generateGroundedText: async () => {
      calls += 1
      throw quotaError()
    },
  })
  let today = new Date('2026-08-31T12:00:00-07:00') // noon Pacific
  const client = createQuotaAwareGeminiClient(inner, () => today)

  await expect(client.generateGroundedText('p1')).rejects.toThrow('quota exceeded')
  await expect(client.generateGroundedText('p2')).rejects.toThrow('already confirmed exhausted')

  today = new Date('2026-09-01T12:00:00-07:00') // next day, Pacific
  await expect(client.generateGroundedText('p3')).rejects.toThrow('quota exceeded') // tries the inner client again

  expect(calls).toBe(2)
})

test('createQuotaAwareGeminiClient does not gate generateJson', async () => {
  let jsonCalls = 0
  const inner = fakeGeminiClient({
    generateJson: async () => {
      jsonCalls += 1
      return { ok: true }
    },
    generateGroundedText: async () => {
      throw quotaError()
    },
  })
  const client = createQuotaAwareGeminiClient(inner)

  await expect(client.generateGroundedText('p')).rejects.toThrow('quota exceeded')
  await client.generateJson('p', {})
  await client.generateJson('p', {})

  expect(jsonCalls).toBe(2)
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
