import { createCache } from './cache'

function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

test('wrap returns the loaded value and reuses it within the ttl', async () => {
  const clock = fakeClock()
  const cache = createCache({ ttlMs: 1000, now: clock.now })
  let loads = 0
  const load = async () => ++loads

  expect(await cache.wrap('k', ['t'], load)).toBe(1)
  clock.advance(999)
  expect(await cache.wrap('k', ['t'], load)).toBe(1)
  expect(loads).toBe(1)
})

test('wrap reloads once the ttl has passed', async () => {
  const clock = fakeClock()
  const cache = createCache({ ttlMs: 1000, now: clock.now })
  let loads = 0
  const load = async () => ++loads

  await cache.wrap('k', [], load)
  clock.advance(1000)

  expect(await cache.wrap('k', [], load)).toBe(2)
})

test('different keys are cached independently', async () => {
  const cache = createCache({ ttlMs: 1000 })

  const a = await cache.wrap('a', [], async () => 'A')
  const b = await cache.wrap('b', [], async () => 'B')

  expect([a, b]).toEqual(['A', 'B'])
})

test('invalidate drops every entry carrying the tag and leaves the rest', async () => {
  const cache = createCache({ ttlMs: 1000 })
  let aLoads = 0
  let bLoads = 0
  await cache.wrap('a', ['products-list'], async () => ++aLoads)
  await cache.wrap('b', ['needs-review'], async () => ++bLoads)

  cache.invalidate('products-list')

  expect(await cache.wrap('a', ['products-list'], async () => ++aLoads)).toBe(2)
  expect(await cache.wrap('b', ['needs-review'], async () => ++bLoads)).toBe(1)
})

test('concurrent wraps of one key share a single load', async () => {
  const cache = createCache({ ttlMs: 1000 })
  let loads = 0
  const load = async () => {
    loads++
    return 'v'
  }

  const results = await Promise.all([cache.wrap('k', [], load), cache.wrap('k', [], load)])

  expect(results).toEqual(['v', 'v'])
  expect(loads).toBe(1)
})

test('a failed load is not cached', async () => {
  const cache = createCache({ ttlMs: 1000 })
  let calls = 0

  await expect(
    cache.wrap('k', [], async () => {
      calls++
      throw new Error('db down')
    }),
  ).rejects.toThrow('db down')

  expect(await cache.wrap('k', [], async () => 'recovered')).toBe('recovered')
  expect(calls).toBe(1)
})

test('a load that finishes after an invalidate does not repopulate the cache with stale data', async () => {
  const cache = createCache({ ttlMs: 1000 })
  let release: (v: string) => void = () => {}
  const slow = new Promise<string>((resolve) => (release = resolve))

  const pending = cache.wrap('k', ['t'], () => slow)
  cache.invalidate('t')
  release('stale')
  await pending

  expect(await cache.wrap('k', ['t'], async () => 'fresh')).toBe('fresh')
})
