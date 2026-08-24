import { existsSync, rmSync } from 'node:fs'
import { createRefreshHandler } from '../refresh-server'
import { createLogger } from '../../src/logger'
import type { PageDriver } from '../../src/driver'
import type { DbClient } from '../../src/db'
import type { ImageStore } from '../../src/images'

const LOG_PATH = 'test/tmp-refresh-server.log'
const API_KEY = 'test-secret'

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
    factory: async () => ({ driver, close: async () => { closed = true } }),
    wasClosed: () => closed,
  }
}

test('rejects a request with the wrong or missing API key', async () => {
  const logger = createLogger(LOG_PATH)
  const handle = createRefreshHandler(API_KEY, fakeDb(), fakeImageStore(), logger, driverFactory(makeDriver()).factory)

  const wrongKey = await handle('1', 'Bearer nope')
  expect(wrongKey).toEqual({ statusCode: 401, body: { error: 'unauthorized' } })

  const noHeader = await handle('1', undefined)
  expect(noHeader).toEqual({ statusCode: 401, body: { error: 'unauthorized' } })
})

test('rejects a missing or non-string id', async () => {
  const logger = createLogger(LOG_PATH)
  const handle = createRefreshHandler(API_KEY, fakeDb(), fakeImageStore(), logger, driverFactory(makeDriver()).factory)

  expect(await handle(undefined, `Bearer ${API_KEY}`)).toEqual({
    statusCode: 400,
    body: { error: 'missing or invalid "id"' },
  })
  expect(await handle(42, `Bearer ${API_KEY}`)).toEqual({
    statusCode: 400,
    body: { error: 'missing or invalid "id"' },
  })
  expect(await handle('  ', `Bearer ${API_KEY}`)).toEqual({
    statusCode: 400,
    body: { error: 'missing or invalid "id"' },
  })
})

test('404s when the listing id does not exist', async () => {
  const logger = createLogger(LOG_PATH)
  const handle = createRefreshHandler(API_KEY, fakeDb(), fakeImageStore(), logger, driverFactory(makeDriver()).factory)

  const result = await handle('does-not-exist', `Bearer ${API_KEY}`)
  expect(result).toEqual({ statusCode: 404, body: { error: 'listing does-not-exist not found' } })
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
  const handle = createRefreshHandler(API_KEY, fakeDb(), fakeImageStore(), logger, factory)

  const result = await handle('1', `Bearer ${API_KEY}`)

  expect(result).toEqual({ statusCode: 200, body: { status: 'alive' } })
  expect(openedId).toBe('1')
  expect(wasClosed()).toBe(true)
})

test('a second request while one is in flight gets 429, not a concurrent browser launch', async () => {
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
  const handle = createRefreshHandler(API_KEY, fakeDb(), fakeImageStore(), logger, slowFactory)

  const firstRequest = handle('1', `Bearer ${API_KEY}`)
  await Promise.resolve() // let the first request reach the driver factory before firing the second
  const secondResult = await handle('1', `Bearer ${API_KEY}`)

  expect(secondResult).toEqual({
    statusCode: 429,
    body: { error: 'a refresh is already in progress, try again shortly' },
  })
  expect(launchCount).toBe(1)

  resolveFirst()
  const firstResult = await firstRequest
  expect(firstResult.statusCode).toBe(200)
})

test('the busy flag clears after a request finishes, so a later request succeeds', async () => {
  const logger = createLogger(LOG_PATH)
  const driver = makeDriver({ getDetailHtml: async () => realListingDetailHtml })
  const handle = createRefreshHandler(API_KEY, fakeDb(), fakeImageStore(), logger, driverFactory(driver).factory)

  const first = await handle('1', `Bearer ${API_KEY}`)
  const second = await handle('1', `Bearer ${API_KEY}`)

  expect(first.statusCode).toBe(200)
  expect(second.statusCode).toBe(200)
})
