import { rmSync } from 'node:fs'
import { checkOneListing } from './recheck'
import { createLogger } from '../../platform/logger'
import type { PageDriver } from './driver'
import type { DbClient } from '../../platform/storage'
import type { ListingPhotos } from './photos'
import { createListingPhotos } from './photos'

const LOG_PATH = 'data/tmp-check-listings.log'

const noDelay = async () => {}

afterEach(() => {
  rmSync(LOG_PATH, { force: true })
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

function fakeDb(): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return { rows: [] }
      },
    },
  }
}

function fakeImageStore(): { store: ListingPhotos; deletedPrefixes: string[] } {
  const deletedPrefixes: string[] = []
  return {
    deletedPrefixes,
    store: createListingPhotos({
      store: {
        put: async (key: string) => `https://images.example.com/${key}`,
        deleteAll: async (prefix: string) => {
          deletedPrefixes.push(prefix)
        },
        list: async () => [],
        delete: async () => {},
      },
      fetchBytes: async () => null,
      compress: async (body, contentType) => ({ body, contentType }),
      logger: createLogger(LOG_PATH),
    }),
  }
}

const realListingDetailHtml = `<script type="application/json">{"id":"1","marketplace_listing_title":"RTX 3060"}</script>`
const soldListingDetailHtml = `<script type="application/json">{"id":"1","marketplace_listing_title":"RTX 3060","is_sold":true}</script>`
const softWallHtml = `<div class="login_form">You must log in to continue</div>`
const hardBlockHtml = `<div class="checkpoint_challenge">captcha</div>`

test('checkOneListing returns a status describing what happened, for callers other than the batch loop', async () => {
  const { db: db1 } = fakeDb()
  const { store } = fakeImageStore()
  const logger = createLogger(LOG_PATH)

  const alive = await checkOneListing(
    {
      driver: makeDriver({ getDetailHtml: async () => realListingDetailHtml }),
      db: db1,
      photos: store,
      logger,
      delay: noDelay,
    },
    { id: '1', flagged_removed_at: null, source_photo_ids: null },
  )
  expect(alive).toEqual({ status: 'alive' })

  const { db: db2 } = fakeDb()
  const sold = await checkOneListing(
    {
      driver: makeDriver({ getDetailHtml: async () => soldListingDetailHtml }),
      db: db2,
      photos: store,
      logger,
      delay: noDelay,
    },
    { id: '1', flagged_removed_at: null, source_photo_ids: null },
  )
  expect(sold).toEqual({ status: 'sold' })

  const { db: db3 } = fakeDb()
  const flagged = await checkOneListing(
    { driver: makeDriver({ getDetailHtml: async () => softWallHtml }), db: db3, photos: store, logger, delay: noDelay },
    { id: '1', flagged_removed_at: null, source_photo_ids: null },
    10,
  )
  expect(flagged).toEqual({ status: 'flagged' })

  const { db: db4 } = fakeDb()
  const removed = await checkOneListing(
    { driver: makeDriver({ getDetailHtml: async () => softWallHtml }), db: db4, photos: store, logger, delay: noDelay },
    { id: '1', flagged_removed_at: '2026-08-01T00:00:00Z', source_photo_ids: null },
    10,
  )
  expect(removed).toEqual({ status: 'removed' })

  const { db: db5 } = fakeDb()
  const blocked = await checkOneListing(
    {
      driver: makeDriver({ getDetailHtml: async () => hardBlockHtml }),
      db: db5,
      photos: store,
      logger,
      delay: noDelay,
    },
    {
      id: '1',
      flagged_removed_at: null,
      source_photo_ids: null,
    },
  )
  expect(blocked).toEqual({ status: 'hard-block' })
})

test('checkOneListing does not navigate or pace itself - that stays with the caller', async () => {
  let openListingCalled = false
  let waitRandomCalled = false
  const driver = makeDriver({
    getDetailHtml: async () => realListingDetailHtml,
    openListing: async () => {
      openListingCalled = true
    },
    waitRandom: async () => {
      waitRandomCalled = true
    },
  })
  const { db } = fakeDb()
  const { store } = fakeImageStore()
  const logger = createLogger(LOG_PATH)

  await checkOneListing(
    { driver, db, photos: store, logger, delay: noDelay },
    { id: '1', flagged_removed_at: null, source_photo_ids: null },
  )

  expect(openListingCalled).toBe(false)
  expect(waitRandomCalled).toBe(false)
})
