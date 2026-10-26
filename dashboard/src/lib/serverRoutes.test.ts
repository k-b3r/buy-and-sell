import { expect, test } from 'vitest'
import { resolveServerPath, SERVER_ROUTES, serverUrlFor } from './serverRoutes'

const BASE = 'https://vps.test'

// The proxy's own two steps, in order: match the path once, then build the
// server URL from that one match.
function target(pathname: string, search = '') {
  const serverPath = resolveServerPath(SERVER_ROUTES, pathname)
  return serverPath === null ? null : serverUrlFor(serverPath, search, BASE).toString()
}

function isServerRoute(pathname: string) {
  return resolveServerPath(SERVER_ROUTES, pathname) !== null
}

test('a migrated /api path maps to the same path on the server, minus /api', () => {
  expect(target('/api/settings')).toBe('https://vps.test/settings')
  expect(target('/api/collect-keywords')).toBe('https://vps.test/collect-keywords')
})

test('/api/real-estate goes to the server with its filters intact', () => {
  expect(target('/api/real-estate', '?kind=sale&page=2')).toBe('https://vps.test/real-estate?kind=sale&page=2')
})

test('the query string is kept', () => {
  expect(target('/api/settings', '?a=1')).toBe('https://vps.test/settings?a=1')
})

test('paths still served by Next handlers resolve to nothing', () => {
  expect(target('/api/login')).toBeNull()
  expect(target('/api/listings/123')).toBeNull()
  expect(target('/admin/settings')).toBeNull()
})

test('a path that only shares a prefix does not match', () => {
  expect(target('/api/settings-old')).toBeNull()
})

test('only migrated exact paths match, not their subpaths', () => {
  expect(isServerRoute('/api/settings')).toBe(true)
  expect(isServerRoute('/api/settings/x')).toBe(false)
  expect(isServerRoute('/api/listings/123/refresh/x')).toBe(false)
})

test('serverUrlFor tolerates a trailing slash on the base url', () => {
  expect(serverUrlFor('/settings', '', 'https://vps.test/').toString()).toBe('https://vps.test/settings')
})

const ROUTES = [
  { pattern: '/api/products' },
  { pattern: '/api/products/:id/listings' },
  { pattern: '/api/products/:id/refresh', serverPath: '/refresh/products/:id' },
]

test('resolveServerPath matches an exact pattern with no params', () => {
  expect(resolveServerPath(ROUTES, '/api/products')).toBe('/products')
})

test('resolveServerPath matches a :param as exactly one segment', () => {
  expect(resolveServerPath(ROUTES, '/api/products/42/listings')).toBe('/products/42/listings')
})

test('resolveServerPath does not match extra segments', () => {
  expect(resolveServerPath(ROUTES, '/api/products/42/listings/7')).toBeNull()
  expect(resolveServerPath(ROUTES, '/api/products/42')).toBeNull()
  expect(resolveServerPath(ROUTES, '/api/products/')).toBeNull()
})

test('resolveServerPath does not match a missing or empty segment', () => {
  expect(resolveServerPath(ROUTES, '/api/products//listings')).toBeNull()
  expect(resolveServerPath(ROUTES, '/api/products/listings')).toBeNull()
})

test('resolveServerPath leaves unmigrated siblings of a migrated pattern to Next', () => {
  expect(resolveServerPath(ROUTES, '/api/products/42/exclude')).toBeNull()
})

test('resolveServerPath uses the per-entry server path, filling in its params', () => {
  expect(resolveServerPath(ROUTES, '/api/products/42/refresh')).toBe('/refresh/products/42')
})

test('the catalog routes resolve to their server paths and leave their unmigrated siblings to Next', () => {
  expect(target('/api/products', '?q=iphone&offset=30')).toBe('https://vps.test/products?q=iphone&offset=30')
  expect(target('/api/products/42/listings', '?sort=price_asc')).toBe(
    'https://vps.test/products/42/listings?sort=price_asc',
  )
  expect(target('/api/products/42/mark-reviewed')).toBe('https://vps.test/products/42/mark-reviewed')
  expect(isServerRoute('/api/products/42')).toBe(false)
})

test('the listing save toggle goes to the server, keeping the productId query', () => {
  expect(target('/api/listings/123/save', '?productId=7')).toBe('https://vps.test/listings/123/save?productId=7')
})

test('the listing save and refresh toggles match, but not the listing itself', () => {
  expect(isServerRoute('/api/listings/123/save')).toBe(true)
  expect(isServerRoute('/api/listings/123/refresh')).toBe(true)
  expect(isServerRoute('/api/listings/123')).toBe(false)
})

test('the refresh, job, logs and worker-control paths go to the same path on the server', () => {
  for (const path of [
    '/api/listings/123/refresh',
    '/api/products/42/refresh',
    '/api/refresh-job',
    '/api/refresh-job/cancel',
    '/api/logs',
    '/api/worker-control',
  ]) {
    expect(target(path)).toBe(`https://vps.test${path.slice('/api'.length)}`)
  }
})

test('the pricing routes resolve to their server paths, bodies and all', () => {
  expect(target('/api/deals', '?minTier=sold_comps&offset=30')).toBe(
    'https://vps.test/deals?minTier=sold_comps&offset=30',
  )
  expect(target('/api/notifications')).toBe('https://vps.test/notifications')
  expect(target('/api/notifications/9/read')).toBe('https://vps.test/notifications/9/read')
  expect(target('/api/notifications/mark-all-read')).toBe('https://vps.test/notifications/mark-all-read')
  for (const action of ['exclude', 'include', 'manual-price']) {
    expect(target(`/api/products/42/${action}`)).toBe(`https://vps.test/products/42/${action}`)
  }
})

test('the pricing routes do not swallow the notification or product siblings still on Next', () => {
  expect(isServerRoute('/api/notifications/9')).toBe(false)
  expect(isServerRoute('/api/notifications/9/unread')).toBe(false)
})
