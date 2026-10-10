import type { Logger } from '../logger'
import type { DbClient } from '../storage'
import type { JsonClient } from './gateway'
import { createGatewayBreaker, createGatewayClient, loadGatewayConfig, withGateway } from './gateway'

const config = { baseUrl: 'http://localhost:13001/v1', apiKey: 'gw-key', models: ['auto'] }

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

test('loadGatewayConfig defaults to the router auto pick and strips a trailing slash', () => {
  expect(loadGatewayConfig({ LLM_GATEWAY_URL: 'http://x/v1/', LLM_GATEWAY_API_KEY: 'k' })).toEqual({
    baseUrl: 'http://x/v1',
    apiKey: 'k',
    models: ['auto'],
  })
})

test('loadGatewayConfig reads a comma list of pinned models, trimming blanks', () => {
  const env = {
    LLM_GATEWAY_URL: 'http://x/v1',
    LLM_GATEWAY_API_KEY: 'k',
    LLM_GATEWAY_MODEL: ' gpt-oss-120b, qwen3.8-27b ,',
  }

  expect(loadGatewayConfig(env)?.models).toEqual(['gpt-oss-120b', 'qwen3.8-27b'])
})

test('loadGatewayConfig lets a per-worker pin override the global one', () => {
  const env = {
    LLM_GATEWAY_URL: 'http://x/v1',
    LLM_GATEWAY_API_KEY: 'k',
    LLM_GATEWAY_MODEL: 'gpt-oss-120b',
    LLM_GATEWAY_MODEL_VERIFY_DISCOUNT_NOTIFICATIONS: 'mistral-large-3',
  }

  expect(loadGatewayConfig(env, 'verify-discount-notifications')?.models).toEqual(['mistral-large-3'])
  expect(loadGatewayConfig(env, 'extract-products')?.models).toEqual(['gpt-oss-120b'])
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

function modelsOf(calls: { init: RequestInit }[]): string[] {
  return calls.map((c) => JSON.parse(c.init.body as string).model)
}

// Answers each request from `statuses` in order (200 carries a JSON body).
function sequencedFetch(statuses: number[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const status = statuses[calls.length - 1] ?? 200
    const body = status === 200 ? chatBody('{"ok":true}') : { error: { message: `status ${status}` } }
    return new Response(JSON.stringify(body), { status })
  }
  return { fetchFn, calls }
}

test('generateJson tries the pinned model first and does not touch auto when it answers', async () => {
  const { fetchFn, calls } = sequencedFetch([200])
  const client = createGatewayClient({ ...config, models: ['gpt-oss-120b'] }, { fetchFn })

  expect(await client.generateJson('p', {})).toEqual({ ok: true })
  expect(modelsOf(calls)).toEqual(['gpt-oss-120b'])
})

test('generateJson falls through the pinned models in order, then auto, and reports each hop', async () => {
  const { fetchFn, calls } = sequencedFetch([404, 429, 200])
  const hops: string[] = []
  const client = createGatewayClient(
    { ...config, models: ['model-a', 'model-b'] },
    { fetchFn, onFallback: (from, to, reason) => hops.push(`${from}>${to}:${reason}`) },
  )

  expect(await client.generateJson('p', {})).toEqual({ ok: true })
  expect(modelsOf(calls)).toEqual(['model-a', 'model-b', 'auto'])
  expect(hops).toEqual([expect.stringMatching(/^model-a>model-b:.*404/), expect.stringMatching(/^model-b>auto:.*429/)])
})

test('generateJson throws the last error when every pinned model and auto fail', async () => {
  const { fetchFn, calls } = sequencedFetch([404, 503])
  const client = createGatewayClient({ ...config, models: ['gpt-oss-120b'] }, { fetchFn })

  await expect(client.generateJson('p', {})).rejects.toMatchObject({ status: 503 })
  expect(modelsOf(calls)).toEqual(['gpt-oss-120b', 'auto'])
})

test('generateJson does not call auto twice when the config already ends with it', async () => {
  const { fetchFn, calls } = sequencedFetch([500, 500])
  const client = createGatewayClient({ ...config, models: ['gpt-oss-120b', 'auto'] }, { fetchFn })

  await expect(client.generateJson('p', {})).rejects.toThrow()
  expect(modelsOf(calls)).toEqual(['gpt-oss-120b', 'auto'])
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

test('withGateway falls back to the direct client when the gateway never answers within the timeout', async () => {
  const hangingFetch = (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })
  const logger = fakeLogger()
  const client = withGateway(direct, config, { db: settingsDb(1), logger, fetchFn: hangingFetch, timeoutMs: 10 })

  expect(await client.generateJson('p', {})).toEqual({ from: 'direct' })
  expect(logger.lines).toEqual([expect.stringMatching(/^warn LLM gateway failed/)])
})

test('withGateway skips the gateway for a cooldown after it fails, then tries it again', async () => {
  let now = 1_000
  const { fetchFn, calls } = sequencedFetch([500, 200])
  const breaker = createGatewayBreaker({ now: () => now, cooldownMs: 60_000 })
  const client = withGateway(direct, config, { db: settingsDb(1), logger: fakeLogger(), fetchFn, breaker })

  expect(await client.generateJson('p', {})).toEqual({ from: 'direct' })
  expect(calls).toHaveLength(1)

  now += 30_000
  expect(await client.generateJson('p', {})).toEqual({ from: 'direct' })
  expect(calls).toHaveLength(1)

  now += 31_000
  expect(await client.generateJson('p', {})).toEqual({ ok: true })
  expect(calls).toHaveLength(2)
})

test('two wrappers sharing one breaker both skip the gateway after either one trips it', async () => {
  const { fetchFn, calls } = sequencedFetch([500])
  const breaker = createGatewayBreaker({ now: () => 0, cooldownMs: 60_000 })
  const deps = { db: settingsDb(1), logger: fakeLogger(), fetchFn, breaker }
  const first = withGateway(direct, config, deps)
  const otherDirect: JsonClient = { generateJson: async () => ({ from: 'direct2' }) }
  const second = withGateway(otherDirect, config, deps)

  await first.generateJson('p', {})
  expect(await second.generateJson('p', {})).toEqual({ from: 'direct2' })
  expect(calls).toHaveLength(1)
})
