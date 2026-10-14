import { expect, test } from 'vitest'
import { isServerRoute, resolveServerPath, serverRouteTarget } from './serverRoutes'

const BASE = 'https://vps.test'

test('serverRouteTarget maps a migrated /api path to the same path on the server, minus /api', () => {
  expect(serverRouteTarget('/api/settings', '', BASE)?.toString()).toBe('https://vps.test/settings')
  expect(serverRouteTarget('/api/collect-keywords', '', BASE)?.toString()).toBe('https://vps.test/collect-keywords')
})

test('serverRouteTarget sends /api/real-estate to the server with its filters intact', () => {
  expect(serverRouteTarget('/api/real-estate', '?kind=sale&page=2', BASE)?.toString()).toBe(
    'https://vps.test/real-estate?kind=sale&page=2',
  )
})

test('serverRouteTarget keeps the query string', () => {
  expect(serverRouteTarget('/api/settings', '?a=1', BASE)?.toString()).toBe('https://vps.test/settings?a=1')
})

test('serverRouteTarget returns null for paths still served by Next handlers', () => {
  expect(serverRouteTarget('/api/login', '', BASE)).toBeNull()
  expect(serverRouteTarget('/api/listings/123', '', BASE)).toBeNull()
  expect(serverRouteTarget('/admin/settings', '', BASE)).toBeNull()
})

test('serverRouteTarget does not match a path that only shares a prefix', () => {
  expect(serverRouteTarget('/api/settings-old', '', BASE)).toBeNull()
})

test('isServerRoute is true for migrated exact paths only, not their subpaths', () => {
  expect(isServerRoute('/api/settings')).toBe(true)
  expect(isServerRoute('/api/settings/x')).toBe(false)
  expect(isServerRoute('/api/listings/123/refresh/x')).toBe(false)
})

test('serverRouteTarget tolerates a trailing slash on the base url', () => {
  expect(serverRouteTarget('/api/settings', '', 'https://vps.test/')?.toString()).toBe('https://vps.test/settings')
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
  expect(serverRouteTarget('/api/products', '?q=iphone&offset=30', BASE)?.toString()).toBe(
    'https://vps.test/products?q=iphone&offset=30',
  )
  expect(serverRouteTarget('/api/products/42/listings', '?sort=price_asc', BASE)?.toString()).toBe(
    'https://vps.test/products/42/listings?sort=price_asc',
  )
  expect(serverRouteTarget('/api/products/42/mark-reviewed', '', BASE)?.toString()).toBe(
    'https://vps.test/products/42/mark-reviewed',
  )
  expect(isServerRoute('/api/products/42')).toBe(false)
})

test('serverRouteTarget sends the listing save toggle to the server, keeping the productId query', () => {
  expect(serverRouteTarget('/api/listings/123/save', '?productId=7', BASE)?.toString()).toBe(
    'https://vps.test/listings/123/save?productId=7',
  )
})

test('isServerRoute matches the listing save and refresh toggles but not the listing itself', () => {
  expect(isServerRoute('/api/listings/123/save')).toBe(true)
  expect(isServerRoute('/api/listings/123/refresh')).toBe(true)
  expect(isServerRoute('/api/listings/123')).toBe(false)
})

test('serverRouteTarget sends the refresh, job, logs and worker-control paths to the same path on the server', () => {
  for (const path of [
    '/api/listings/123/refresh',
    '/api/products/42/refresh',
    '/api/refresh-job',
    '/api/refresh-job/cancel',
    '/api/logs',
    '/api/worker-control',
  ]) {
    expect(serverRouteTarget(path, '', BASE)?.toString()).toBe(`https://vps.test${path.slice('/api'.length)}`)
  }
})

test('the pricing routes resolve to their server paths, bodies and all', () => {
  expect(serverRouteTarget('/api/deals', '?minTier=sold_comps&offset=30', BASE)?.toString()).toBe(
    'https://vps.test/deals?minTier=sold_comps&offset=30',
  )
  expect(serverRouteTarget('/api/notifications', '', BASE)?.toString()).toBe('https://vps.test/notifications')
  expect(serverRouteTarget('/api/notifications/9/read', '', BASE)?.toString()).toBe(
    'https://vps.test/notifications/9/read',
  )
  expect(serverRouteTarget('/api/notifications/mark-all-read', '', BASE)?.toString()).toBe(
    'https://vps.test/notifications/mark-all-read',
  )
  for (const action of ['exclude', 'include', 'manual-price']) {
    expect(serverRouteTarget(`/api/products/42/${action}`, '', BASE)?.toString()).toBe(
      `https://vps.test/products/42/${action}`,
    )
  }
})

test('the pricing routes do not swallow the notification or product siblings still on Next', () => {
  expect(isServerRoute('/api/notifications/9')).toBe(false)
  expect(isServerRoute('/api/notifications/9/unread')).toBe(false)
})
