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
  expect(serverRouteTarget('/api/deals', '', BASE)).toBeNull()
  expect(serverRouteTarget('/admin/settings', '', BASE)).toBeNull()
})

test('serverRouteTarget does not match a path that only shares a prefix', () => {
  expect(serverRouteTarget('/api/settings-old', '', BASE)).toBeNull()
})

test('isServerRoute is true for migrated exact paths only, not their subpaths', () => {
  expect(isServerRoute('/api/settings')).toBe(true)
  expect(isServerRoute('/api/settings/x')).toBe(false)
  expect(isServerRoute('/api/deals')).toBe(false)
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
