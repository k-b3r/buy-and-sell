import { expect, test } from 'vitest'
import { serverRouteTarget } from './serverRoutes'

const BASE = 'https://vps.test'

test('serverRouteTarget maps a migrated /api path to the same path on the server, minus /api', () => {
  expect(serverRouteTarget('/api/settings', '', BASE)?.toString()).toBe('https://vps.test/settings')
  expect(serverRouteTarget('/api/collect-keywords', '', BASE)?.toString()).toBe('https://vps.test/collect-keywords')
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

test('serverRouteTarget tolerates a trailing slash on the base url', () => {
  expect(serverRouteTarget('/api/settings', '', 'https://vps.test/')?.toString()).toBe('https://vps.test/settings')
})
