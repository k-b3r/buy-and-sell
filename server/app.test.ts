import { handleRequest } from './app'
import type { RouteTable } from './app'
import { createRateLimiter } from './rateLimiter'

const API_KEY = 'test-secret'
const IP = '1.2.3.4'

function freshLimiter() {
  return createRateLimiter(10, 5 * 60 * 1000)
}

test('routes a matching method+path to its handler and returns the parsed body to it', async () => {
  let receivedBody: unknown
  const routes: RouteTable = {
    'POST /refresh': async (body) => {
      receivedBody = body
      return { statusCode: 200, body: { ok: true } }
    },
  }

  const result = await handleRequest(routes, API_KEY, 'POST', '/refresh', `Bearer ${API_KEY}`, '{"id":"123"}', IP, freshLimiter())

  expect(result).toEqual({ statusCode: 200, body: { ok: true } })
  expect(receivedBody).toEqual({ id: '123' })
})

test('404s for an unregistered method+path combination', async () => {
  const routes: RouteTable = { 'POST /refresh': async () => ({ statusCode: 200, body: {} }) }
  const limiter = freshLimiter()

  expect(await handleRequest(routes, API_KEY, 'GET', '/refresh', `Bearer ${API_KEY}`, '', IP, limiter)).toEqual({
    statusCode: 404,
    body: { error: 'not found' },
  })
  expect(await handleRequest(routes, API_KEY, 'POST', '/nope', `Bearer ${API_KEY}`, '', IP, limiter)).toEqual({
    statusCode: 404,
    body: { error: 'not found' },
  })
})

test('rejects a wrong or missing bearer token for a route that exists', async () => {
  const routes: RouteTable = { 'POST /refresh': async () => ({ statusCode: 200, body: {} }) }

  expect(await handleRequest(routes, API_KEY, 'POST', '/refresh', 'Bearer wrong', '{}', IP, freshLimiter())).toEqual({
    statusCode: 401,
    body: { error: 'unauthorized' },
  })
  expect(await handleRequest(routes, API_KEY, 'POST', '/refresh', undefined, '{}', IP, freshLimiter())).toEqual({
    statusCode: 401,
    body: { error: 'unauthorized' },
  })
})

test('400s on an invalid JSON body for an authenticated, matching route', async () => {
  const routes: RouteTable = { 'POST /refresh': async () => ({ statusCode: 200, body: {} }) }

  const result = await handleRequest(routes, API_KEY, 'POST', '/refresh', `Bearer ${API_KEY}`, 'not json', IP, freshLimiter())

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

  await handleRequest(routes, API_KEY, 'POST', '/refresh', `Bearer ${API_KEY}`, '', IP, freshLimiter())

  expect(receivedBody).toEqual({})
})

test('a second route can be registered independently and gets the same auth for free', async () => {
  const routes: RouteTable = {
    'POST /refresh': async () => ({ statusCode: 200, body: { from: 'refresh' } }),
    'POST /other-thing': async () => ({ statusCode: 200, body: { from: 'other-thing' } }),
  }
  const limiter = freshLimiter()

  const refresh = await handleRequest(routes, API_KEY, 'POST', '/refresh', `Bearer ${API_KEY}`, '{}', IP, limiter)
  const other = await handleRequest(routes, API_KEY, 'POST', '/other-thing', `Bearer ${API_KEY}`, '{}', IP, limiter)
  const otherUnauthed = await handleRequest(routes, API_KEY, 'POST', '/other-thing', 'Bearer wrong', '{}', IP, limiter)

  expect(refresh.body).toEqual({ from: 'refresh' })
  expect(other.body).toEqual({ from: 'other-thing' })
  expect(otherUnauthed).toEqual({ statusCode: 401, body: { error: 'unauthorized' } })
})

test('an IP gets 429 after repeated auth failures, even with the correct token', async () => {
  const routes: RouteTable = { 'POST /refresh': async () => ({ statusCode: 200, body: {} }) }
  const limiter = createRateLimiter(3, 5 * 60 * 1000)

  await handleRequest(routes, API_KEY, 'POST', '/refresh', 'Bearer wrong', '{}', IP, limiter)
  await handleRequest(routes, API_KEY, 'POST', '/refresh', 'Bearer wrong', '{}', IP, limiter)
  await handleRequest(routes, API_KEY, 'POST', '/refresh', 'Bearer wrong', '{}', IP, limiter)

  const result = await handleRequest(routes, API_KEY, 'POST', '/refresh', `Bearer ${API_KEY}`, '{}', IP, limiter)

  expect(result).toEqual({ statusCode: 429, body: { error: 'too many failed attempts, try again later' } })
})

test('rate limiting is per-IP - one IP failing does not block another', async () => {
  const routes: RouteTable = { 'POST /refresh': async () => ({ statusCode: 200, body: { ok: true } }) }
  const limiter = createRateLimiter(2, 5 * 60 * 1000)

  await handleRequest(routes, API_KEY, 'POST', '/refresh', 'Bearer wrong', '{}', '1.1.1.1', limiter)
  await handleRequest(routes, API_KEY, 'POST', '/refresh', 'Bearer wrong', '{}', '1.1.1.1', limiter)

  const otherIp = await handleRequest(routes, API_KEY, 'POST', '/refresh', `Bearer ${API_KEY}`, '{}', '2.2.2.2', limiter)

  expect(otherIp).toEqual({ statusCode: 200, body: { ok: true } })
})

test('a successful request clears prior failures, so the IP is not left blocked', async () => {
  const routes: RouteTable = { 'POST /refresh': async () => ({ statusCode: 200, body: { ok: true } }) }
  const limiter = createRateLimiter(2, 5 * 60 * 1000)

  await handleRequest(routes, API_KEY, 'POST', '/refresh', 'Bearer wrong', '{}', IP, limiter)
  await handleRequest(routes, API_KEY, 'POST', '/refresh', `Bearer ${API_KEY}`, '{}', IP, limiter)
  await handleRequest(routes, API_KEY, 'POST', '/refresh', 'Bearer wrong', '{}', IP, limiter)

  const result = await handleRequest(routes, API_KEY, 'POST', '/refresh', `Bearer ${API_KEY}`, '{}', IP, limiter)

  expect(result.statusCode).toBe(200)
})
