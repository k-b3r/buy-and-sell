import type { Logger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import type { ImageStore } from '../../platform/images'
import type { PageDriver } from './driver'
import { backfillListingPhotos, requireBackfillProxy } from './photo-backfill'
import { createListingPhotos } from './photos'

const realDetailHtml = `<script type="application/json">{"id":"1","marketplace_listing_title":"RTX 3060","listing_photos":[]}</script>`
const softWallHtml = `<div class="login_form">You must log in to continue</div>`
const hardBlockHtml = `<div class="checkpoint_challenge">captcha</div>`

function makeDriver(detailHtml: (id: string) => string): PageDriver & { opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    gotoSearch: async () => {},
    getGridHtml: async () => '<html></html>',
    openListing: async (listing) => {
      opened.push(listing.id)
    },
    getDetailHtml: async () => detailHtml(opened[opened.length - 1]),
    refresh: async () => {},
    waitRandom: async () => {},
    fetchNextPage: async () => '{}',
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

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }
const store: ImageStore = {
  put: async (key) => `https://images.example.com/${key}`,
  deleteAll: async () => {},
  list: async () => [],
  delete: async () => {},
}
const photos = createListingPhotos({
  store,
  fetchBytes: async () => null,
  compress: async (body, contentType) => ({ body, contentType }),
  logger: silentLogger,
})
const noDelay = async () => {}

test('backfillListingPhotos saves the re-scraped listing merged over its stored raw_json', async () => {
  const driver = makeDriver(() => realDetailHtml)
  const { db, calls } = fakeDb()

  const skipped = await backfillListingPhotos({ driver, db, photos, logger: silentLogger, delay: noDelay }, [
    { id: '1', raw_json: { id: '1', location: { latitude: 14.5 } } },
  ])

  expect(skipped).toBe(0)
  const upsert = calls.find((c) => c.sql.includes('INSERT INTO listings'))
  const rawJson = JSON.parse(upsert?.params[14] as string)
  expect(rawJson).toMatchObject({ id: '1', location: { latitude: 14.5 }, stored_photo_urls: [] })
})

test('backfillListingPhotos marks a persistently soft-walled listing unavailable and moves on to the next', async () => {
  const driver = makeDriver((id) => (id === 'gone' ? softWallHtml : realDetailHtml))
  const { db, calls } = fakeDb()

  const skipped = await backfillListingPhotos({ driver, db, photos, logger: silentLogger, delay: noDelay }, [
    { id: 'gone', raw_json: {} },
    { id: '1', raw_json: {} },
  ])

  expect(skipped).toBe(1)
  expect(calls[0]).toEqual({
    sql: `UPDATE listings SET stored_photo_urls = '[]'::jsonb WHERE id = $1`,
    params: ['gone'],
  })
  expect(driver.opened).toEqual(['gone', '1'])
})

test('backfillListingPhotos stops at a hard block without touching that listing or any after it', async () => {
  const driver = makeDriver(() => hardBlockHtml)
  const { db, calls } = fakeDb()

  await backfillListingPhotos({ driver, db, photos, logger: silentLogger, delay: noDelay }, [
    { id: '1', raw_json: {} },
    { id: '2', raw_json: {} },
  ])

  expect(calls).toEqual([])
  expect(driver.opened).toEqual(['1'])
})

test('requireBackfillProxy refuses when no proxy is configured, so the backfill never hits Facebook directly', async () => {
  const checker = async () => true

  await expect(requireBackfillProxy({}, checker)).rejects.toThrow(/refusing to hit Facebook directly/)
})

test('requireBackfillProxy refuses when the configured proxy is unreachable', async () => {
  const checker = async () => false

  await expect(requireBackfillProxy({ SOCKS_PROXY: 'socks5://127.0.0.1:1080' }, checker)).rejects.toThrow(
    /tunnel isn't reachable/,
  )
})

test('requireBackfillProxy returns the resolved proxy when one is reachable', async () => {
  const checker = async () => true

  const proxy = await requireBackfillProxy({ SOCKS_PROXY: 'socks5://127.0.0.1:1080' }, checker)

  expect(proxy).toEqual({
    server: 'socks5://127.0.0.1:1080',
    username: undefined,
    password: undefined,
    source: 'tunnel',
  })
})
