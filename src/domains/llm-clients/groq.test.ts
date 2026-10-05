import type { GroqClient } from './groq'
import {
  createFallbackGroqClient,
  createRoundRobinGroqClient,
  loadGroqApiKeys,
  buildGroqRequest,
  GROQ_MODEL_FALLBACK_CHAIN,
} from './groq'

// createGroqPool (groq-sdk.ts) walks this chain per key. This test just locks
// down the chain's order — best model first — since a wrong order would
// silently under-use a healthy key.
test('GROQ_MODEL_FALLBACK_CHAIN tries the best model first, weakest last', () => {
  expect(GROQ_MODEL_FALLBACK_CHAIN).toEqual(['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'])
})

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

test('fallback client fires onFallback with the from/to labels the moment it switches', async () => {
  const primary: GroqClient = {
    generateJson: async () => {
      const err = new Error('quota exceeded') as Error & { status: number }
      err.status = 429
      throw err
    },
  }
  const secondary: GroqClient = { generateJson: async () => ({ from: 'secondary' }) }
  const events: [string, string][] = []
  const client = createFallbackGroqClient([primary, secondary], {
    labels: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    onFallback: (from, to) => events.push([from, to]),
  })

  await client.generateJson('p', {})

  expect(events).toEqual([['openai/gpt-oss-120b', 'openai/gpt-oss-20b']])
})

test('loadGroqApiKeys reads GROQ_API_KEY0, GROQ_API_KEY1, ... until the next index is unset', () => {
  expect(loadGroqApiKeys({ GROQ_API_KEY0: 'a', GROQ_API_KEY1: 'b', GROQ_API_KEY2: 'c' })).toEqual(['a', 'b', 'c'])
  expect(loadGroqApiKeys({ GROQ_API_KEY0: 'a', GROQ_API_KEY2: 'c' })).toEqual(['a'])
  expect(loadGroqApiKeys({})).toEqual([])
})

test('round-robin client rotates across clients instead of always starting from the first', async () => {
  const calls: string[] = []
  const makeClient = (name: string): GroqClient => ({
    generateJson: async () => {
      calls.push(name)
      return { from: name }
    },
  })
  const client = createRoundRobinGroqClient([makeClient('a'), makeClient('b'), makeClient('c')])

  await client.generateJson('p1', {})
  await client.generateJson('p2', {})
  await client.generateJson('p3', {})
  await client.generateJson('p4', {})

  expect(calls).toEqual(['a', 'b', 'c', 'a'])
})

test('round-robin client permanently drops a client that hits a quota error and keeps rotating the rest', async () => {
  let bCalls = 0
  const a: GroqClient = { generateJson: async () => ({ from: 'a' }) }
  const b: GroqClient = {
    generateJson: async () => {
      bCalls += 1
      const err = new Error('quota exceeded') as Error & { status: number }
      err.status = 429
      throw err
    },
  }
  const c: GroqClient = { generateJson: async () => ({ from: 'c' }) }
  const client = createRoundRobinGroqClient([a, b, c])

  await client.generateJson('p1', {}) // a
  const second = await client.generateJson('p2', {}) // b 429s -> falls to c
  const third = await client.generateJson('p3', {}) // a again (b permanently dropped)

  expect(second).toEqual({ from: 'c' })
  expect(third).toEqual({ from: 'a' })
  expect(bCalls).toBe(1)
})

test('round-robin client rethrows non-quota errors without rotating away from the failing client', async () => {
  let aCalls = 0
  const a: GroqClient = {
    generateJson: async () => {
      aCalls += 1
      throw new Error('some other failure')
    },
  }
  const b: GroqClient = { generateJson: async () => ({ from: 'b' }) }
  const client = createRoundRobinGroqClient([a, b])

  await expect(client.generateJson('p', {})).rejects.toThrow('some other failure')
  expect(aCalls).toBe(1)
})

test('round-robin client rethrows the quota error once every client is exhausted', async () => {
  const exhausted: GroqClient = {
    generateJson: async () => {
      const err = new Error('quota exceeded') as Error & { status: number }
      err.status = 429
      throw err
    },
  }
  const client = createRoundRobinGroqClient([exhausted, exhausted])

  await expect(client.generateJson('p', {})).rejects.toThrow('quota exceeded')
})

test('round-robin client fires onFallback with the from/to key labels the moment it drops one', async () => {
  const a: GroqClient = { generateJson: async () => ({ from: 'a' }) }
  const b: GroqClient = {
    generateJson: async () => {
      const err = new Error('quota exceeded') as Error & { status: number }
      err.status = 429
      throw err
    },
  }
  const events: [string, string][] = []
  const client = createRoundRobinGroqClient([a, b], {
    labels: ['GROQ_API_KEY0', 'GROQ_API_KEY1'],
    onFallback: (from, to) => events.push([from, to]),
  })

  await client.generateJson('p1', {}) // a
  await client.generateJson('p2', {}) // b 429s -> drops, falls to a

  expect(events).toEqual([['GROQ_API_KEY1', 'GROQ_API_KEY0']])
})

test('buildGroqRequest without options is the exact request every existing worker sends', () => {
  const req = buildGroqRequest('openai/gpt-oss-120b', 'hi', { type: 'object' })
  expect(req).toEqual({
    model: 'openai/gpt-oss-120b',
    messages: [{ role: 'user', content: 'hi' }],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'response', strict: true, schema: { type: 'object' } },
    },
  })
})

test('buildGroqRequest adds reasoning effort and an output cap only when asked', () => {
  const req = buildGroqRequest(
    'openai/gpt-oss-120b',
    'hi',
    { type: 'object' },
    { reasoningEffort: 'low', maxCompletionTokens: 4096 },
  )
  expect(req).toMatchObject({ reasoning_effort: 'low', max_completion_tokens: 4096 })
})
