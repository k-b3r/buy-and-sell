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

// Every dashboard query is served by a resource route in its feature module,
// so the whitelist is empty until the route itself is removed (BUY-84).
test('the whitelist is empty: every query is served by its resource route', () => {
  expect(QUERY_NAMES).toEqual([])
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

test('refuses the names that used to be on the whitelist', async () => {
  const db = fakeDb()
  const handler = createQueryHandler(db)

  for (const name of ['getListingProductId', 'getListingDetail', 'getDeals', 'getProductDetail', 'setManualPrice']) {
    const result = await handler({ name, args: [] })
    expect(result.statusCode).toBe(400)
  }
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

  for (const body of [{}, { name: 42 }, null, { name: 'getListingProductId', args: 'nope' }]) {
    const result = await handler(body)
    expect(result.statusCode).toBe(400)
  }
  expect(db.query).not.toHaveBeenCalled()
})
