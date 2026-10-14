import type { RouteHandler } from './app'
import { invalidateAfterQuery } from './queryInvalidation'

function fakeCache() {
  const invalidated: string[][] = []
  return {
    invalidated,
    wrap: async <T>(_key: string, _tags: string[], load: () => Promise<T>) => load(),
    invalidate: (...tags: string[]) => {
      invalidated.push(tags)
    },
  }
}

const ok: RouteHandler = async () => ({ statusCode: 200, body: { result: null } })
const failed: RouteHandler = async () => ({ statusCode: 500, body: { error: 'query failed' } })

test('a successful setManualPrice drops the product, list and review-queue caches', async () => {
  const cache = fakeCache()
  const handler = invalidateAfterQuery(ok, cache)

  const result = await handler({ name: 'setManualPrice', args: [42, { kind: 'new', priceLow: 1, priceHigh: 2 }] })

  expect(result.statusCode).toBe(200)
  expect(cache.invalidated).toEqual([['needs-review', 'products-list', 'product:42']])
})

test.each(['excludeProductFromReview', 'includeInPricing'])('a successful %s drops the same caches', async (name) => {
  const cache = fakeCache()

  await invalidateAfterQuery(ok, cache)({ name, args: [7, 'manual_review'] })

  expect(cache.invalidated).toEqual([['needs-review', 'products-list', 'product:7']])
})

test('a failed mutation leaves the caches alone', async () => {
  const cache = fakeCache()

  await invalidateAfterQuery(failed, cache)({ name: 'includeInPricing', args: [7] })

  expect(cache.invalidated).toEqual([])
})

test('reads and malformed bodies never invalidate', async () => {
  const cache = fakeCache()
  const handler = invalidateAfterQuery(ok, cache)

  await handler({ name: 'getDeals', args: [] })
  await handler({ name: 'includeInPricing', args: ['nope'] })
  await handler(null)

  expect(cache.invalidated).toEqual([])
})
