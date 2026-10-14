import { expect, test } from 'vitest'
import { hashPassword } from './auth'
import { decideProxy, type ProxyInput } from './proxyDecision'

const ENV = { DASHBOARD_PASSWORD: 'test-pass', REFRESH_SERVER_URL: 'https://vps.test', REFRESH_API_KEY: 'test-key' }

function input(overrides: Partial<ProxyInput> = {}): ProxyInput {
  return {
    pathname: '/api/real-estate',
    search: '',
    authCookie: hashPassword('test-pass'),
    contentType: null,
    env: ENV,
    ...overrides,
  }
}

test('a logged-in /api request for a migrated route is rewritten to the server path with the query string', () => {
  const decision = decideProxy(input({ search: '?kind=sale&page=2' }))

  expect(decision.kind).toBe('rewrite')
  if (decision.kind !== 'rewrite') return
  expect(decision.target.toString()).toBe('https://vps.test/real-estate?kind=sale&page=2')
})

test('the rewrite forwards only content-type and the bearer key, never the auth cookie or other client headers', () => {
  const decision = decideProxy(input({ pathname: '/api/settings', contentType: 'application/json' }))

  expect(decision.kind).toBe('rewrite')
  if (decision.kind !== 'rewrite') return
  expect([...decision.headers.keys()].sort()).toEqual(['authorization', 'content-type'])
  expect(decision.headers.get('authorization')).toBe('Bearer test-key')
  expect(decision.headers.get('content-type')).toBe('application/json')
})

test('the rewrite omits content-type when the request has none', () => {
  const decision = decideProxy(input())

  expect(decision.kind).toBe('rewrite')
  if (decision.kind !== 'rewrite') return
  expect([...decision.headers.keys()]).toEqual(['authorization'])
})

test('a logged-out request is sent to /login before any rewrite', () => {
  expect(decideProxy(input({ authCookie: undefined })).kind).toBe('login')
  expect(decideProxy(input({ authCookie: 'wrong' })).kind).toBe('login')
})

test('a request is sent to /login when the dashboard password is not configured', () => {
  const decision = decideProxy(input({ env: { ...ENV, DASHBOARD_PASSWORD: undefined } }))

  expect(decision.kind).toBe('login')
})

test('the login check runs before the server env check, so a logged-out request never learns the server is down', () => {
  const decision = decideProxy(input({ authCookie: undefined, env: { DASHBOARD_PASSWORD: 'test-pass' } }))

  expect(decision.kind).toBe('login')
})

test('a migrated route answers unavailable when the server url or key is missing', () => {
  const noUrl = decideProxy(input({ env: { ...ENV, REFRESH_SERVER_URL: undefined } }))
  const noKey = decideProxy(input({ env: { ...ENV, REFRESH_API_KEY: undefined } }))

  expect(noUrl).toEqual({ kind: 'unavailable', pathname: '/api/real-estate' })
  expect(noKey).toEqual({ kind: 'unavailable', pathname: '/api/real-estate' })
})

test('/api/login is never rewritten and needs no cookie', () => {
  expect(decideProxy(input({ pathname: '/api/login', authCookie: undefined }))).toEqual({ kind: 'next' })
  expect(decideProxy(input({ pathname: '/api/login' }))).toEqual({ kind: 'next' })
})

test('the login page and robots.txt are reachable logged out', () => {
  expect(decideProxy(input({ pathname: '/login', authCookie: undefined }))).toEqual({ kind: 'next' })
  expect(decideProxy(input({ pathname: '/robots.txt', authCookie: undefined }))).toEqual({ kind: 'next' })
})

test('an /api path no server route matches is left to Next, not rewritten', () => {
  expect(decideProxy(input({ pathname: '/api/not-a-migrated-route' }))).toEqual({ kind: 'next' })
  expect(decideProxy(input({ pathname: '/api/settings/extra' }))).toEqual({ kind: 'next' })
})

test('a page request passes through for a logged-in user', () => {
  expect(decideProxy(input({ pathname: '/real-estate' }))).toEqual({ kind: 'next' })
})
