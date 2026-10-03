import { existsSync, rmSync } from 'node:fs'
import { createRefreshHandler } from './refresh'
import { createRefreshLock } from '../refreshLock'
import { createRefreshPacer } from '../refreshPacer'
import { createLogger } from '../../src/platform/logger'
import type { PageDriver } from '../../src/domains/marketplace'
import type { DbClient } from '../../src/platform/storage'
import type { ImageStore } from '../../src/platform/images'

const LOG_PATH = 'data/tmp-refresh.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function makeDriver(overrides: Partial<PageDriver> = {}): PageDriver {
  return {
    gotoSearch: async () => {},
    getGridHtml: async () => '<html></html>',
    openListing: async () => {},
    getDetailHtml: async () => '<html></html>',
    refresh: async () => {},
    waitRandom: async () => {},
    fetchNextPage: async () => '{}',
    ...overrides,
  }
}

// Only listing '1' exists — matches getListingCheckCandidate's single-row
// SELECT, distinct from the generic "always empty rows" fakes used
// elsewhere, since these tests specifically need a found/not-found split.
function fakeDb(): DbClient {
  return {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT')) {
        return params[0] === '1' ? { rows: [{ id: '1', flagged_removed_at: null }] } : { rows: [] }
      }
      return { rows: [] }
    },
  }
}

function fakeImageStore(): ImageStore {
  return {
    put: async (key: string) => `https://images.example.com/${key}`,
    deleteAll: async () => {},
  }
}

const realListingDetailHtml = `<script type="application/json">{"id":"1","marketplace_listing_title":"RTX 3060"}</script>`

function driverFactory(driver: PageDriver) {
  let closed = false
  return {
    factory: async () => ({
      driver,
      close: async () => {
        closed = true
      },
    }),
    wasClosed: () => closed,
  }
}

// Every test below is exercising something other than the tunnel guard
// itself (see proxyGuard.test.ts for that) - a passing check by default
// keeps them from depending on real SOCKS_PROXY env state.
const okTunnel = async () => ({ ok: true as const })

// No pacing gap to wait out and an already-free lock - real timers are fine
// for a single call, since recordActionComplete never having fired means no
// delay() call happens at all.
function instantPacer(lock = createRefreshLock()) {
  return createRefreshPacer(lock)
}

// For tests that make more than one call through the same pacer - after the
// first call's recordActionComplete, a real pacer would actually wait out
// the 4-10s gap with real timers. Auto-advancing fake time keeps the real
// pacing logic under test without the test itself taking seconds.
function fastPacer(lock = createRefreshLock()) {
  let time = 0
  return createRefreshPacer(
    lock,
    () => time,
    async (ms) => {
      time += ms
    },
  )
}

test('rejects a missing or non-string id', async () => {
  const logger = createLogger(LOG_PATH)
  const handle = createRefreshHandler(
    fakeDb(),
    fakeImageStore(),
    logger,
    instantPacer(),
    driverFactory(makeDriver()).factory,
    okTunnel,
  )

  expect(await handle({})).toEqual({ statusCode: 400, body: { error: 'missing or invalid "id"' } })
  expect(await handle({ id: 42 })).toEqual({ statusCode: 400, body: { error: 'missing or invalid "id"' } })
  expect(await handle({ id: '  ' })).toEqual({ statusCode: 400, body: { error: 'missing or invalid "id"' } })
  expect(await handle(null)).toEqual({ statusCode: 400, body: { error: 'missing or invalid "id"' } })
})

test('404s when the listing id does not exist, without ever queueing', async () => {
  const logger = createLogger(LOG_PATH)
  const handle = createRefreshHandler(
    fakeDb(),
    fakeImageStore(),
    logger,
    instantPacer(),
    driverFactory(makeDriver()).factory,
    okTunnel,
  )

  const result = await handle({ id: 'does-not-exist' })
  expect(result).toEqual({ statusCode: 404, body: { error: 'listing does-not-exist not found' } })
})

test('503s and takes no action when the tunnel is not reachable', async () => {
  const logger = createLogger(LOG_PATH)
  let driverFactoryCalled = false
  const badTunnel = async () => ({ ok: false as const, error: 'SOCKS_PROXY is not configured' })
  const handle = createRefreshHandler(
    fakeDb(),
    fakeImageStore(),
    logger,
    instantPacer(),
    async () => {
      driverFactoryCalled = true
      return { driver: makeDriver(), close: async () => {} }
    },
    badTunnel,
  )

  const result = await handle({ id: '1' })

  expect(result).toEqual({ statusCode: 503, body: { error: 'SOCKS_PROXY is not configured' } })
  expect(driverFactoryCalled).toBe(false) // no browser ever launched, no action taken
})

test('opens the listing, runs checkOneListing, closes the driver, and returns its status', async () => {
  const logger = createLogger(LOG_PATH)
  let openedId: unknown
  const driver = makeDriver({
    getDetailHtml: async () => realListingDetailHtml,
    openListing: async (listing) => {
      openedId = listing.id
    },
  })
  const { factory, wasClosed } = driverFactory(driver)
  const handle = createRefreshHandler(fakeDb(), fakeImageStore(), logger, instantPacer(), factory, okTunnel)

  const result = await handle({ id: '1' })

  expect(result).toEqual({ statusCode: 200, body: { status: 'alive' } })
  expect(openedId).toBe('1')
  expect(wasClosed()).toBe(true)
})

test('a second request while one is in flight queues and succeeds once the first releases the lock', async () => {
  const logger = createLogger(LOG_PATH)
  let resolveFirst: () => void = () => {}
  const firstGate = new Promise<void>((resolve) => {
    resolveFirst = resolve
  })
  let launchCount = 0
  const slowFactory = async () => {
    launchCount += 1
    await firstGate
    return { driver: makeDriver({ getDetailHtml: async () => realListingDetailHtml }), close: async () => {} }
  }
  const pacer = fastPacer()
  const handle = createRefreshHandler(fakeDb(), fakeImageStore(), logger, pacer, slowFactory, okTunnel)

  const firstRequest = handle({ id: '1' })
  await Promise.resolve() // let the first request reach the driver factory before firing the second
  const secondRequest = handle({ id: '1' })

  resolveFirst()
  const [firstResult, secondResult] = await Promise.all([firstRequest, secondRequest])

  expect(firstResult.statusCode).toBe(200)
  expect(secondResult.statusCode).toBe(200)
  // Queued behind the first, not run concurrently - one browser launch each,
  // in sequence, not two racing.
  expect(launchCount).toBe(2)
})

test('gives up with 429 if the lock never frees within the max queue wait', async () => {
  const logger = createLogger(LOG_PATH)
  const lock = createRefreshLock()
  lock.acquire() // e.g. a bulk product-refresh job holding it, never released in this test
  let time = 0
  const now = () => time
  const delay = async (ms: number) => {
    time += ms
  }
  const pacer = createRefreshPacer(lock, now, delay)
  const handle = createRefreshHandler(
    fakeDb(),
    fakeImageStore(),
    logger,
    pacer,
    driverFactory(makeDriver()).factory,
    okTunnel,
  )

  const result = await handle({ id: '1' })

  expect(result).toEqual({ statusCode: 429, body: { error: 'a refresh is already in progress, try again shortly' } })
})

test('a later request succeeds after an earlier one completes and releases', async () => {
  const logger = createLogger(LOG_PATH)
  const driver = makeDriver({ getDetailHtml: async () => realListingDetailHtml })
  const handle = createRefreshHandler(
    fakeDb(),
    fakeImageStore(),
    logger,
    fastPacer(),
    driverFactory(driver).factory,
    okTunnel,
  )

  const first = await handle({ id: '1' })
  const second = await handle({ id: '1' })

  expect(first.statusCode).toBe(200)
  expect(second.statusCode).toBe(200)
})
