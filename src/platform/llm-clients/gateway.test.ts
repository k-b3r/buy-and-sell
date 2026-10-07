import type { Logger } from '../logger'
import type { DbClient } from '../storage'
import type { JsonClient } from './gateway'
import { createGatewayClient, loadGatewayConfig, withGateway } from './gateway'

const config = { baseUrl: 'http://localhost:13001/v1', apiKey: 'gw-key', model: 'auto' }

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
  }
  return { fetchFn, calls }
}

function chatBody(content: string) {
  return { choices: [{ message: { content } }] }
}

function fakeLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (msg) => lines.push(`info ${msg}`),
    warn: (msg) => lines.push(`warn ${msg}`),
    error: (msg) => lines.push(`error ${msg}`),
  }
}

function settingsDb(enabled: number | null): DbClient {
  return {
    query: async () => ({ rows: enabled === null ? [] : [{ key: 'llm.gateway_enabled', value: enabled }] }),
  } as DbClient
}

test('loadGatewayConfig returns null unless both the URL and the API key are set', () => {
  expect(loadGatewayConfig({})).toBeNull()
  expect(loadGatewayConfig({ LLM_GATEWAY_URL: 'http://x/v1' })).toBeNull()
  expect(loadGatewayConfig({ LLM_GATEWAY_API_KEY: 'k' })).toBeNull()
})

test('loadGatewayConfig defaults the model to the router auto pick and strips a trailing slash', () => {
  expect(loadGatewayConfig({ LLM_GATEWAY_URL: 'http://x/v1/', LLM_GATEWAY_API_KEY: 'k' })).toEqual({
    baseUrl: 'http://x/v1',
    apiKey: 'k',
    model: 'auto',
  })
  expect(
    loadGatewayConfig({ LLM_GATEWAY_URL: 'http://x/v1', LLM_GATEWAY_API_KEY: 'k', LLM_GATEWAY_MODEL: 'auto:extract' }),
  ).toMatchObject({ model: 'auto:extract' })
})

test('generateJson posts a strict json_schema chat completion with the configured model and key', async () => {
  const { fetchFn, calls } = fakeFetch(200, chatBody('{"brand":"Apple"}'))
  const client = createGatewayClient(config, { fetchFn })
  const schema = { type: 'object' }

  expect(await client.generateJson('extract this', schema)).toEqual({ brand: 'Apple' })
  expect(calls[0].url).toBe('http://localhost:13001/v1/chat/completions')
  expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer gw-key')
  expect(JSON.parse(calls[0].init.body as string)).toEqual({
    model: 'auto',
    messages: [{ role: 'user', content: 'extract this' }],
    response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema } },
  })
})

test('generateJson forwards reasoning effort and completion cap when given', async () => {
  const { fetchFn, calls } = fakeFetch(200, chatBody('{}'))
  const client = createGatewayClient(config, {
    fetchFn,
    requestOptions: { reasoningEffort: 'low', maxCompletionTokens: 4000 },
  })

  await client.generateJson('p', {})
  expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
    reasoning_effort: 'low',
    max_completion_tokens: 4000,
  })
})

test('generateJson reports the x-routed-via provider only when it changes between calls', async () => {
  const routes: string[] = []
  const served = ['groq/qwen/qwen3.8-27b', 'groq/qwen/qwen3.8-27b', 'google/gemini-3.7-flash']
  const fetchFn = async () =>
    new Response(JSON.stringify(chatBody('{}')), { status: 200, headers: { 'x-routed-via': served.shift() ?? '' } })
  const client = createGatewayClient(config, { fetchFn, onRoute: (route) => routes.push(route) })

  for (let i = 0; i < 3; i++) await client.generateJson('p', {})
  expect(routes).toEqual(['groq/qwen/qwen3.8-27b', 'google/gemini-3.7-flash'])
})

test('generateJson throws with the HTTP status on a non-2xx response', async () => {
  const { fetchFn } = fakeFetch(429, { error: { message: 'All models rate-limited' } })
  const client = createGatewayClient(config, { fetchFn })

  await expect(client.generateJson('p', {})).rejects.toMatchObject({ status: 429 })
})

test('generateJson throws when the response has no content', async () => {
  const { fetchFn } = fakeFetch(200, { choices: [] })
  const client = createGatewayClient(config, { fetchFn })

  await expect(client.generateJson('p', {})).rejects.toThrow('no content')
})

function gatewayFetch(result: 'ok' | 'rate-limited') {
  return fakeFetch(
    result === 'ok' ? 200 : 429,
    result === 'ok' ? chatBody('{"from":"gateway"}') : { error: { message: 'All models rate-limited' } },
    { 'x-routed-via': 'groq/qwen/qwen3.8-27b' },
  ).fetchFn
}

const direct: JsonClient = { generateJson: async () => ({ from: 'direct' }) }

test('withGateway returns the direct client itself when no gateway is configured', () => {
  expect(withGateway(direct, null, { db: settingsDb(1), logger: fakeLogger() })).toBe(direct)
})

test('withGateway sends generateJson to the gateway when the setting is on and logs the serving model', async () => {
  const logger = fakeLogger()
  const client = withGateway(direct, config, { db: settingsDb(1), logger, fetchFn: gatewayFetch('ok') })

  expect(await client.generateJson('p', {})).toEqual({ from: 'gateway' })
  expect(logger.lines).toEqual(['info LLM gateway now served by groq/qwen/qwen3.8-27b'])
})

test('withGateway keeps using the direct client when the setting is off or missing', async () => {
  for (const enabled of [0, null]) {
    const client = withGateway(direct, config, {
      db: settingsDb(enabled),
      logger: fakeLogger(),
      fetchFn: gatewayFetch('ok'),
    })
    expect(await client.generateJson('p', {})).toEqual({ from: 'direct' })
  }
})

test('withGateway falls back to the direct client and logs why when the gateway call fails', async () => {
  const logger = fakeLogger()
  const client = withGateway(direct, config, { db: settingsDb(1), logger, fetchFn: gatewayFetch('rate-limited') })

  expect(await client.generateJson('p', {})).toEqual({ from: 'direct' })
  expect(logger.lines).toEqual([expect.stringMatching(/^warn LLM gateway failed.*rate-limited.*direct/)])
})

test('withGateway forwards request options to the gateway call', async () => {
  const { fetchFn, calls } = fakeFetch(200, chatBody('{}'))
  const client = withGateway(direct, config, {
    db: settingsDb(1),
    logger: fakeLogger(),
    fetchFn,
    requestOptions: { maxCompletionTokens: 4000 },
  })

  await client.generateJson('p', {})
  expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ max_completion_tokens: 4000 })
})

test('withGateway leaves every other method of the direct client in place', async () => {
  const grounded = { ...direct, generateGroundedText: async (prompt: string) => `grounded ${prompt}` }
  const client = withGateway(grounded, config, { db: settingsDb(1), logger: fakeLogger(), fetchFn: gatewayFetch('ok') })

  expect(await client.generateGroundedText('q')).toBe('grounded q')
})
