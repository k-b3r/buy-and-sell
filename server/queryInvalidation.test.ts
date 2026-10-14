import { vi } from 'vitest'
import type { RouteHandler } from './app'
import { invalidateAfterJobStatus, invalidateAfterListingRefresh, invalidateAfterQuery } from './queryInvalidation'

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

test('a finished or cancelled bulk job drops its product caches, a running one does not', async () => {
  const statusOf =
    (status: string): RouteHandler =>
    async () => ({
      statusCode: 200,
      body: { productId: 9, status },
    })
  const cache = fakeCache()

  await invalidateAfterJobStatus(statusOf('running'), cache)(undefined)
  await invalidateAfterJobStatus(statusOf('completed'), cache)(undefined)
  await invalidateAfterJobStatus(statusOf('cancelled'), cache)(undefined)
  await invalidateAfterJobStatus(async () => ({ statusCode: 200, body: null }), cache)(undefined)

  expect(cache.invalidated).toEqual([
    ['products-list', 'product:9'],
    ['products-list', 'product:9'],
  ])
})

test('a successful listing refresh drops the list and the listing product caches', async () => {
  const cache = fakeCache()
  const lookup = vi.fn(async () => 5)

  const result = await invalidateAfterListingRefresh(ok, cache, lookup)({ id: 'abc' })

  expect(result.statusCode).toBe(200)
  expect(lookup).toHaveBeenCalledWith('abc')
  expect(cache.invalidated).toEqual([['products-list'], ['products-list', 'product:5']])
})

test('a failed listing refresh invalidates nothing and skips the lookup', async () => {
  const cache = fakeCache()
  const lookup = vi.fn(async () => 5)

  await invalidateAfterListingRefresh(failed, cache, lookup)({ id: 'abc' })

  expect(lookup).not.toHaveBeenCalled()
  expect(cache.invalidated).toEqual([])
})

test('a failing product lookup still returns the refresh result and keeps the list invalidation', async () => {
  const cache = fakeCache()

  const result = await invalidateAfterListingRefresh(ok, cache, async () => {
    throw new Error('db down')
  })({ id: 'abc' })

  expect(result.statusCode).toBe(200)
  expect(cache.invalidated).toEqual([['products-list']])
})

test('reads and malformed bodies never invalidate', async () => {
  const cache = fakeCache()
  const handler = invalidateAfterQuery(ok, cache)

  await handler({ name: 'getDeals', args: [] })
  await handler({ name: 'includeInPricing', args: ['nope'] })
  await handler(null)

  expect(cache.invalidated).toEqual([])
})
