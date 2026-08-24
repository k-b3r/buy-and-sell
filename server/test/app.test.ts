import { handleRequest } from '../app'
import type { RouteTable } from '../app'

const API_KEY = 'test-secret'

test('routes a matching method+path to its handler and returns the parsed body to it', async () => {
  let receivedBody: unknown
  const routes: RouteTable = {
    'POST /refresh': async (body) => {
      receivedBody = body
      return { statusCode: 200, body: { ok: true } }
    },
  }

  const result = await handleRequest(routes, API_KEY, 'POST', '/refresh', `Bearer ${API_KEY}`, '{"id":"123"}')

  expect(result).toEqual({ statusCode: 200, body: { ok: true } })
  expect(receivedBody).toEqual({ id: '123' })
})

test('404s for an unregistered method+path combination', async () => {
  const routes: RouteTable = { 'POST /refresh': async () => ({ statusCode: 200, body: {} }) }

  expect(await handleRequest(routes, API_KEY, 'GET', '/refresh', `Bearer ${API_KEY}`, '')).toEqual({
    statusCode: 404,
    body: { error: 'not found' },
  })
  expect(await handleRequest(routes, API_KEY, 'POST', '/nope', `Bearer ${API_KEY}`, '')).toEqual({
    statusCode: 404,
    body: { error: 'not found' },
  })
})

test('rejects a wrong or missing bearer token for a route that exists', async () => {
  const routes: RouteTable = { 'POST /refresh': async () => ({ statusCode: 200, body: {} }) }

  expect(await handleRequest(routes, API_KEY, 'POST', '/refresh', 'Bearer wrong', '{}')).toEqual({
    statusCode: 401,
    body: { error: 'unauthorized' },
  })
  expect(await handleRequest(routes, API_KEY, 'POST', '/refresh', undefined, '{}')).toEqual({
    statusCode: 401,
    body: { error: 'unauthorized' },
  })
})

test('400s on an invalid JSON body for an authenticated, matching route', async () => {
  const routes: RouteTable = { 'POST /refresh': async () => ({ statusCode: 200, body: {} }) }

  const result = await handleRequest(routes, API_KEY, 'POST', '/refresh', `Bearer ${API_KEY}`, 'not json')

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

  await handleRequest(routes, API_KEY, 'POST', '/refresh', `Bearer ${API_KEY}`, '')

  expect(receivedBody).toEqual({})
})

test('a second route can be registered independently and gets the same auth for free', async () => {
  const routes: RouteTable = {
    'POST /refresh': async () => ({ statusCode: 200, body: { from: 'refresh' } }),
    'POST /other-thing': async () => ({ statusCode: 200, body: { from: 'other-thing' } }),
  }

  const refresh = await handleRequest(routes, API_KEY, 'POST', '/refresh', `Bearer ${API_KEY}`, '{}')
  const other = await handleRequest(routes, API_KEY, 'POST', '/other-thing', `Bearer ${API_KEY}`, '{}')
  const otherUnauthed = await handleRequest(routes, API_KEY, 'POST', '/other-thing', 'Bearer wrong', '{}')

  expect(refresh.body).toEqual({ from: 'refresh' })
  expect(other.body).toEqual({ from: 'other-thing' })
  expect(otherUnauthed).toEqual({ statusCode: 401, body: { error: 'unauthorized' } })
})
