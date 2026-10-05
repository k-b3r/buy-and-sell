import { expect, test, vi } from 'vitest'
import { createQueryHandler, QUERY_NAMES } from './query'
import type { RouteResult } from '../app'
import type { QueryClient } from '../../src/platform/storage'

function fakeDb(rows: unknown[] = []): QueryClient {
  return { query: vi.fn(async () => ({ rows })) }
}

function asBody<T>(result: RouteResult): T {
  return result.body as T
}

test('runs a whitelisted query by name and returns its result', async () => {
  const db = fakeDb([{ count: '7' }])
  const handler = createQueryHandler(db)

  const result = await handler({ name: 'getUnreadDiscountNotificationCount', args: [] })

  expect(result.statusCode).toBe(200)
  expect(asBody<{ result: unknown }>(result).result).toBe(7)
})

test('forwards args through to the underlying query', async () => {
  const db = fakeDb([])
  const handler = createQueryHandler(db)

  await handler({ name: 'getDiscountNotifications', args: [5] })

  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('discount_notifications'), [5])
})

// The whole point of the whitelist: a leaked bearer token must not be able to
// run SQL the app doesn't already ship. Anything not in the registry is
// refused before it can reach the database at all.
test('refuses a name that is not on the whitelist', async () => {
  const db = fakeDb()
  const handler = createQueryHandler(db)

  const result = await handler({ name: 'dropEverything', args: [] })

  expect(result.statusCode).toBe(400)
  expect(asBody<{ error: string }>(result).error).toMatch(/unknown query/i)
  expect(db.query).not.toHaveBeenCalled()
})

// Raw SQL in the `name` slot is the exact attack the whitelist exists to
// stop - it must be treated as just another unknown name, never executed.
test('never executes raw SQL passed as a name', async () => {
  const db = fakeDb()
  const handler = createQueryHandler(db)

  const result = await handler({ name: 'DROP TABLE listings', args: [] })

  expect(result.statusCode).toBe(400)
  expect(db.query).not.toHaveBeenCalled()
})

test('rejects a malformed body', async () => {
  const db = fakeDb()
  const handler = createQueryHandler(db)

  for (const body of [{}, { name: 42 }, null, { name: 'getSavedListings', args: 'nope' }]) {
    const result = await handler(body)
    expect(result.statusCode).toBe(400)
  }
  expect(db.query).not.toHaveBeenCalled()
})

test('defaults args to empty when omitted', async () => {
  const db = fakeDb([])
  const handler = createQueryHandler(db)

  const result = await handler({ name: 'getSavedListings' })

  expect(result.statusCode).toBe(200)
})

// A query that throws must not leak the underlying SQL/driver error text to
// the caller - it is surfaced as a generic 500 and logged server-side.
test('turns a failing query into a 500 without leaking driver detail', async () => {
  const db: QueryClient = {
    query: vi.fn(async () => {
      throw new Error('relation "listings" does not exist')
    }),
  }
  const handler = createQueryHandler(db)

  const result = await handler({ name: 'getSavedListings', args: [] })

  expect(result.statusCode).toBe(500)
  expect(JSON.stringify(result.body)).not.toMatch(/relation/)
})

test('whitelist covers every db-backed query the dashboard calls', () => {
  expect(QUERY_NAMES).toContain('getProductSummaries')
  expect(QUERY_NAMES).toContain('getDeals')
  expect(QUERY_NAMES).toContain('getProductDetail')
  expect(QUERY_NAMES.length).toBeGreaterThanOrEqual(24)
})

test('the registry exposes getRealEstateListings', () => {
  expect(QUERY_NAMES).toContain('getRealEstateListings')
})
