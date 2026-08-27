import { existsSync, rmSync } from 'node:fs'
import { createRefreshProductHandler } from './refreshProduct'
import { createRefreshLock } from '../refreshLock'
import { createRefreshPacer } from '../refreshPacer'
import { createJobStore } from '../jobState'
import { createLogger } from '../../src/logger'
import type { PageDriver } from '../../src/driver'
import type { DbClient } from '../../src/storage/client'
import type { ImageStore } from '../../src/images'

const LOG_PATH = 'data/tmp-refresh-product.log'

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

// Two candidates under product 42, everything else (the UPDATE calls inside
// checkOneListing) is a no-op - same "always empty rows" shape used
// elsewhere for db calls whose return value isn't under test.
function fakeDb(): DbClient {
  return {
    query: async (sql: string) => {
      if (sql.includes('WHERE product_id = $1')) {
        return { rows: [{ id: 'a', flagged_removed_at: null }, { id: 'b', flagged_removed_at: null }] }
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

const aliveHtml = (id: string) => `<script type="application/json">{"id":"${id}","marketplace_listing_title":"x"}</script>`

// close() is the last thing the detached loop does (see refreshProduct.ts's
// finally block) - awaiting this promise is a deterministic way to know the
// background loop has fully finished, without polling or arbitrary sleeps.
function driverFactory(driver: PageDriver) {
  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  return {
    factory: async () => ({ driver, close: async () => resolveClosed() }),
    closed,
  }
}

// Every test below is exercising something other than the tunnel guard
// itself (see tunnelGuard.test.ts) - a passing check by default keeps them
// from depending on real SOCKS_PROXY env state.
const okTunnel = async () => ({ ok: true as const })

test('rejects a missing or non-integer productId', async () => {
  const logger = createLogger(LOG_PATH)
  const lock = createRefreshLock()
  const handle = createRefreshProductHandler(
    fakeDb(),
    fakeImageStore(),
    logger,
    lock,
    createJobStore(),
    createRefreshPacer(lock),
    driverFactory(makeDriver()).factory,
    okTunnel,
  )

  expect(await handle({})).toEqual({ statusCode: 400, body: { error: 'missing or invalid "productId"' } })
  expect(await handle({ productId: '42' })).toEqual({ statusCode: 400, body: { error: 'missing or invalid "productId"' } })
  expect(await handle({ productId: 1.5 })).toEqual({ statusCode: 400, body: { error: 'missing or invalid "productId"' } })
})

test('429s when the shared lock is already held', async () => {
  const logger = createLogger(LOG_PATH)
  const lock = createRefreshLock()
  lock.acquire()
  const handle = createRefreshProductHandler(
    fakeDb(),
    fakeImageStore(),
    logger,
    lock,
    createJobStore(),
    createRefreshPacer(lock),
    driverFactory(makeDriver()).factory,
    okTunnel,
  )

  const result = await handle({ productId: 42 })

  expect(result).toEqual({ statusCode: 429, body: { error: 'a refresh is already in progress, try again shortly' } })
})

test('503s and never starts a job when the tunnel is not reachable', async () => {
  const logger = createLogger(LOG_PATH)
  const lock = createRefreshLock()
  const jobs = createJobStore()
  const badTunnel = async () => ({ ok: false as const, error: 'SOCKS_PROXY is not configured' })
  let driverFactoryCalled = false
  const handle = createRefreshProductHandler(
    fakeDb(),
    fakeImageStore(),
    logger,
    lock,
    jobs,
    createRefreshPacer(lock),
    async () => {
      driverFactoryCalled = true
      return { driver: makeDriver(), close: async () => {} }
    },
    badTunnel,
  )

  const result = await handle({ productId: 42 })

  expect(result).toEqual({ statusCode: 503, body: { error: 'SOCKS_PROXY is not configured' } })
  expect(driverFactoryCalled).toBe(false)
  expect(lock.isBusy()).toBe(false)
  expect(jobs.current()).toBeNull()
})

test('a product with no eligible listings completes immediately without acquiring the lock', async () => {
  const logger = createLogger(LOG_PATH)
  const db: DbClient = { query: async () => ({ rows: [] }) } // no candidates
  const lock = createRefreshLock()
  const jobs = createJobStore()
  const handle = createRefreshProductHandler(db, fakeImageStore(), logger, lock, jobs, createRefreshPacer(lock), driverFactory(makeDriver()).factory, okTunnel)

  const result = await handle({ productId: 42 })

  expect(result).toEqual({ statusCode: 200, body: { productId: 42, total: 0 } })
  expect(jobs.current()).toEqual({ productId: 42, total: 0, completed: 0, status: 'completed' })
  expect(lock.isBusy()).toBe(false)
})

test('starts the job and returns immediately, then the background loop checks every candidate', async () => {
  const logger = createLogger(LOG_PATH)
  const opened: string[] = []
  const driver = makeDriver({
    openListing: async (listing) => {
      opened.push(listing.id)
    },
    getDetailHtml: async () => aliveHtml(opened[opened.length - 1]),
  })
  const { factory, closed } = driverFactory(driver)
  const lock = createRefreshLock()
  const jobs = createJobStore()
  const handle = createRefreshProductHandler(fakeDb(), fakeImageStore(), logger, lock, jobs, createRefreshPacer(lock), factory, okTunnel)

  const result = await handle({ productId: 42 })

  expect(result).toEqual({ statusCode: 200, body: { productId: 42, total: 2 } })
  expect(jobs.current()?.status).toBe('running') // response returns before the loop finishes

  await closed
  expect(opened).toEqual(['a', 'b'])
  expect(jobs.current()).toEqual({ productId: 42, total: 2, completed: 2, status: 'completed' })
  expect(lock.isBusy()).toBe(false)
})

test('cancellation requested after the first candidate stops the loop before the second', async () => {
  const logger = createLogger(LOG_PATH)
  const jobs = createJobStore()
  const opened: string[] = []
  const driver = makeDriver({
    openListing: async (listing) => {
      opened.push(listing.id)
    },
    getDetailHtml: async () => {
      // Fires once, right after the first candidate's page load - by the
      // time checkOneListing finishes and the loop re-checks cancellation
      // for the second candidate, it's already requested.
      if (opened.length === 1) jobs.requestCancel()
      return aliveHtml(opened[opened.length - 1])
    },
  })
  const { factory, closed } = driverFactory(driver)
  const lock = createRefreshLock()
  const handle = createRefreshProductHandler(fakeDb(), fakeImageStore(), logger, lock, jobs, createRefreshPacer(lock), factory, okTunnel)

  await handle({ productId: 42 })
  await closed

  expect(opened).toEqual(['a'])
  expect(jobs.current()).toEqual({ productId: 42, total: 2, completed: 1, status: 'cancelled' })
  expect(lock.isBusy()).toBe(false)
})

test('a hard-block stops the loop early and still resolves to completed, not stuck running', async () => {
  const logger = createLogger(LOG_PATH)
  const opened: string[] = []
  const driver = makeDriver({
    openListing: async (listing) => {
      opened.push(listing.id)
    },
    // Real hard-block marker (see src/wall.ts's HARD_BLOCK_MARKERS) -
    // resolvePageState needs actual evidence of the captcha widget, not
    // just arbitrary unrecognized html.
    getDetailHtml: async () => '<html><div class="g-recaptcha"></div></html>',
  })
  const { factory, closed } = driverFactory(driver)
  const lock = createRefreshLock()
  const jobs = createJobStore()
  const handle = createRefreshProductHandler(fakeDb(), fakeImageStore(), logger, lock, jobs, createRefreshPacer(lock), factory, okTunnel)

  await handle({ productId: 42 })
  await closed

  expect(opened).toEqual(['a']) // stops before ever opening 'b'
  // The hard-blocked attempt still counts toward "checked" - its outcome
  // was inconclusive, but it wasn't skipped.
  expect(jobs.current()).toEqual({ productId: 42, total: 2, completed: 1, status: 'completed' })
  expect(lock.isBusy()).toBe(false)
})
