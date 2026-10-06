import { handleRequest } from './app'
import type { AppRequest, RouteTable } from './app'
import { createRateLimiter } from './rateLimiter'
import type { RateLimiter } from './rateLimiter'

const API_KEY = 'test-secret'
const IP = '1.2.3.4'

function freshLimiter() {
  return createRateLimiter(10, 5 * 60 * 1000)
}

function app(routes: RouteTable, rateLimiter: RateLimiter = freshLimiter()) {
  return { routes, apiKey: API_KEY, rateLimiter }
}

// An authenticated POST /refresh with an empty JSON body from IP, overridable per test.
function req(overrides: Partial<AppRequest> = {}): AppRequest {
  return {
    method: 'POST',
    url: '/refresh',
    authHeader: `Bearer ${API_KEY}`,
    rawBody: '{}',
    clientIp: IP,
    ...overrides,
  }
}

test('routes a matching method+path to its handler and returns the parsed body to it', async () => {
  let receivedBody: unknown
  const routes: RouteTable = {
    'POST /refresh': async (body) => {
      receivedBody = body
      return { statusCode: 200, body: { ok: true } }
    },
  }

  const result = await handleRequest(app(routes), req({ rawBody: '{"id":"123"}' }))

  expect(result).toEqual({ statusCode: 200, body: { ok: true } })
  expect(receivedBody).toEqual({ id: '123' })
})

test('404s for an unregistered method+path combination', async () => {
  const server = app({ 'POST /refresh': async () => ({ statusCode: 200, body: {} }) })

  expect(await handleRequest(server, req({ method: 'GET', rawBody: '' }))).toEqual({
    statusCode: 404,
    body: { error: 'not found' },
  })
  expect(await handleRequest(server, req({ url: '/nope', rawBody: '' }))).toEqual({
    statusCode: 404,
    body: { error: 'not found' },
  })
})

test('rejects a wrong or missing bearer token for a route that exists', async () => {
  const routes: RouteTable = { 'POST /refresh': async () => ({ statusCode: 200, body: {} }) }

  expect(await handleRequest(app(routes), req({ authHeader: 'Bearer wrong' }))).toEqual({
    statusCode: 401,
    body: { error: 'unauthorized' },
  })
  expect(await handleRequest(app(routes), req({ authHeader: undefined }))).toEqual({
    statusCode: 401,
    body: { error: 'unauthorized' },
  })
})

test('400s on an invalid JSON body for an authenticated, matching route', async () => {
  const routes: RouteTable = { 'POST /refresh': async () => ({ statusCode: 200, body: {} }) }

  const result = await handleRequest(app(routes), req({ rawBody: 'not json' }))

  expect(result).toEqual({ statusCode: 400, body: { error: 'invalid JSON body' } })
})

test('treats an empty body as {}', async () => {
  let receivedBody: unknown
  const routes: RouteTable = {
    'POST /refresh': async (body) => {
      receivedBody = body
      return { statusCode: 200, body: {} }
    },
  }

  await handleRequest(app(routes), req({ rawBody: '' }))

  expect(receivedBody).toEqual({})
})

test('a second route can be registered independently and gets the same auth for free', async () => {
  const server = app({
    'POST /refresh': async () => ({ statusCode: 200, body: { from: 'refresh' } }),
    'POST /other-thing': async () => ({ statusCode: 200, body: { from: 'other-thing' } }),
  })

  const refresh = await handleRequest(server, req())
  const other = await handleRequest(server, req({ url: '/other-thing' }))
  const otherUnauthed = await handleRequest(server, req({ url: '/other-thing', authHeader: 'Bearer wrong' }))

  expect(refresh.body).toEqual({ from: 'refresh' })
  expect(other.body).toEqual({ from: 'other-thing' })
  expect(otherUnauthed).toEqual({ statusCode: 401, body: { error: 'unauthorized' } })
})

test('an IP gets 429 after repeated auth failures, even with the correct token', async () => {
  const server = app(
    { 'POST /refresh': async () => ({ statusCode: 200, body: {} }) },
    createRateLimiter(3, 5 * 60 * 1000),
  )

  await handleRequest(server, req({ authHeader: 'Bearer wrong' }))
  await handleRequest(server, req({ authHeader: 'Bearer wrong' }))
  await handleRequest(server, req({ authHeader: 'Bearer wrong' }))

  const result = await handleRequest(server, req())

  expect(result).toEqual({ statusCode: 429, body: { error: 'too many failed attempts, try again later' } })
})

test('rate limiting is per-IP - one IP failing does not block another', async () => {
  const server = app(
    { 'POST /refresh': async () => ({ statusCode: 200, body: { ok: true } }) },
    createRateLimiter(2, 5 * 60 * 1000),
  )

  await handleRequest(server, req({ authHeader: 'Bearer wrong', clientIp: '1.1.1.1' }))
  await handleRequest(server, req({ authHeader: 'Bearer wrong', clientIp: '1.1.1.1' }))

  const otherIp = await handleRequest(server, req({ clientIp: '2.2.2.2' }))

  expect(otherIp).toEqual({ statusCode: 200, body: { ok: true } })
})

test('a successful request clears prior failures, so the IP is not left blocked', async () => {
  const server = app(
    { 'POST /refresh': async () => ({ statusCode: 200, body: { ok: true } }) },
    createRateLimiter(2, 5 * 60 * 1000),
  )

  await handleRequest(server, req({ authHeader: 'Bearer wrong' }))
  await handleRequest(server, req())
  await handleRequest(server, req({ authHeader: 'Bearer wrong' }))

  const result = await handleRequest(server, req())

  expect(result.statusCode).toBe(200)
})

test('a handler that throws becomes a 500 instead of an unhandled rejection that would crash the server', async () => {
  const routes: RouteTable = {
    'POST /refresh': async () => {
      throw new Error('boom')
    },
  }

  const result = await handleRequest(app(routes), req())

  expect(result).toEqual({ statusCode: 500, body: { error: 'internal error' } })
})
