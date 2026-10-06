import { existsSync, rmSync } from 'node:fs'
import { runCheckListings, checkOneListing } from './recheck'
import { createLogger } from '../../platform/logger'
import type { PageDriver } from './driver'
import type { DbClient } from '../../platform/storage'
import type { ListingPhotos } from './photos'
import { createListingPhotos } from './photos'

const LOG_PATH = 'data/tmp-check-listings.log'

const noDelay = async () => {}

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

test('real content found: marks the listing alive, does not flag or delete', async () => {
  const driver = makeDriver({ getDetailHtml: async () => realListingDetailHtml })
  const { db, calls } = fakeDb()
  const { store } = fakeImageStore()
  const logger = createLogger(LOG_PATH)

  await runCheckListings({ driver, db, photos: store, logger, delay: noDelay }, [
    { id: '1', flagged_removed_at: null, source_photo_ids: null },
  ])

  const aliveCall = calls.find((c) => c.sql.includes('last_checked_at = now()'))
  expect(aliveCall?.sql).toContain('flagged_removed_at = NULL')
})

test('real content found: refreshes title/price/description/condition, but not photos', async () => {
  const html = `<script type="application/json">{"id":"1","marketplace_listing_title":"RTX 3060 (price cut)","listing_price":{"amount":"12000","currency":"PHP"}}</script>`
  const driver = makeDriver({ getDetailHtml: async () => html })
  const { db, calls } = fakeDb()
  const { store } = fakeImageStore()
  const logger = createLogger(LOG_PATH)

  await runCheckListings({ driver, db, photos: store, logger, delay: noDelay }, [
    { id: '1', flagged_removed_at: null, source_photo_ids: null },
  ])

  const refreshCall = calls.find((c) => c.sql.includes('last_seen_at = now()'))
  expect(refreshCall).toBeDefined()
  expect(refreshCall?.sql).not.toContain('primary_photo_url')
  expect(refreshCall?.sql).not.toContain('stored_photo_urls')
  expect(refreshCall?.params[0]).toBe('1')
  expect(refreshCall?.params[1]).toBe('RTX 3060 (price cut)')
  expect(refreshCall?.params[2]).toBe(12000)
})

test('real content found with is_sold true: marks the listing sold, not alive', async () => {
  const driver = makeDriver({ getDetailHtml: async () => soldListingDetailHtml })
  const { db, calls } = fakeDb()
  const { store } = fakeImageStore()
  const logger = createLogger(LOG_PATH)

  await runCheckListings({ driver, db, photos: store, logger, delay: noDelay }, [
    { id: '1', flagged_removed_at: null, source_photo_ids: null },
  ])

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('sold_at = now()')
  expect(calls[0].sql).not.toContain('flagged_removed_at = NULL')
})

test('soft-wall persists, not previously flagged: flags it, does not delete', async () => {
  const driver = makeDriver({
    getDetailHtml: async () => softWallHtml,
    refresh: async () => {},
  })
  const { db, calls } = fakeDb()
  const { store, deletedPrefixes } = fakeImageStore()
  const logger = createLogger(LOG_PATH)

  await runCheckListings(
    { driver, db, photos: store, logger, delay: noDelay },
    [{ id: '1', flagged_removed_at: null, source_photo_ids: null }],
    { softWallTimeoutMs: 10 },
  )

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('flagged_removed_at = now()')
  expect(deletedPrefixes).toEqual([])
})

test('soft-wall persists, already flagged from a prior run: confirmed removed, deletes listing and photos', async () => {
  const driver = makeDriver({ getDetailHtml: async () => softWallHtml })
  const { db, calls } = fakeDb()
  const { store, deletedPrefixes } = fakeImageStore()
  const logger = createLogger(LOG_PATH)

  await runCheckListings(
    { driver, db, photos: store, logger, delay: noDelay },
    [{ id: '1', flagged_removed_at: '2026-08-01T00:00:00Z', source_photo_ids: null }],
    { softWallTimeoutMs: 10 },
  )

  expect(deletedPrefixes).toEqual(['listings/1/'])
  const deleteCall = calls.find((c) => c.sql.startsWith('DELETE FROM listings'))
  expect(deleteCall?.params).toEqual(['1'])
})

test('hard-block stops the whole run immediately, does not flag or delete anything', async () => {
  const driver = makeDriver({ getDetailHtml: async () => hardBlockHtml })
  const { db, calls } = fakeDb()
  const { store, deletedPrefixes } = fakeImageStore()
  const logger = createLogger(LOG_PATH)

  await runCheckListings({ driver, db, photos: store, logger, delay: noDelay }, [
    { id: '1', flagged_removed_at: null, source_photo_ids: null },
    { id: '2', flagged_removed_at: null, source_photo_ids: null },
  ])

  expect(calls).toHaveLength(0)
  expect(deletedPrefixes).toEqual([])
})

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

test('paces with waitRandom before each listing', async () => {
  const waits: [number, number][] = []
  const driver = makeDriver({
    getDetailHtml: async () => realListingDetailHtml,
    waitRandom: async (min, max) => {
      waits.push([min, max])
    },
  })
  const { db } = fakeDb()
  const { store } = fakeImageStore()
  const logger = createLogger(LOG_PATH)

  await runCheckListings({ driver, db, photos: store, logger, delay: noDelay }, [
    { id: '1', flagged_removed_at: null, source_photo_ids: null },
    { id: '2', flagged_removed_at: null, source_photo_ids: null },
  ])

  expect(waits).toEqual([
    [2000, 4000],
    [2000, 4000],
  ])
})
