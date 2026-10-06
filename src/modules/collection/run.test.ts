import { readFileSync, rmSync, existsSync } from 'node:fs'
import type { PageDriver } from './driver'
import type { DbClient } from '../../platform/storage'
import type { ReviewDecision } from '../../platform/review'
import { runCollection, resolvePageState } from './run'
import { createLogger } from '../../platform/logger'
import { createListingPhotos } from './photos'

const LOG_PATH = 'data/tmp-run.log'

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

// existingIds simulates listings Postgres already has (from any prior run, any
// machine) — the dedup source runCollection reads once at the start via
// getCollectedListingIds. upsertCalls captures every upsertListing call this
// run makes, in full param-array form (see listings.ts's upsertListing for the
// positional layout: [0]=id, [1]=title, [5]=condition, [11]=stored_photo_urls).
function fakeDb(existingIds: string[] = []): { db: DbClient; upsertCalls: unknown[][] } {
  const upsertCalls: unknown[][] = []
  return {
    upsertCalls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        if (sql === 'SELECT id FROM listings') {
          return { rows: existingIds.map((id) => ({ id })) }
        }
        upsertCalls.push(params)
        return { rows: [] }
      },
    },
  }
}

test('passes daysSinceListed through to the driver, defaulting to 30 when unset', async () => {
  const calls: Array<{ query: string; daysSinceListed: number }> = []
  const driver = makeDriver({
    gotoSearch: async (query, daysSinceListed) => {
      calls.push({ query, daysSinceListed })
    },
  })
  const logger = createLogger(LOG_PATH)

  await runCollection(
    { driver, db: fakeDb().db, logger, delay: noDelay, review: async () => 'approve' },
    {
      query: 'headphones',
      softWallTimeoutMs: 100,
    },
  )
  await runCollection(
    { driver, db: fakeDb().db, logger, delay: noDelay, review: async () => 'approve' },
    {
      query: 'headphones',
      softWallTimeoutMs: 100,
      daysSinceListed: 7,
    },
  )

  expect(calls).toEqual([
    { query: 'headphones', daysSinceListed: 30 },
    { query: 'headphones', daysSinceListed: 7 },
  ])
})

test('approved item gets saved, then loop advances to next item', async () => {
  const gridHtml = `<script type="application/json">{"results":[
    {"id":"1","marketplace_listing_title":"Mic A"},
    {"id":"2","marketplace_listing_title":"Mic B"}
  ]}</script>`
  const detailHtml = (id: string) =>
    `<script type="application/json">{"id":"${id}","marketplace_listing_title":"Mic","condition":"Used"}</script>`

  let detailCallIndex = 0
  const ids = ['1', '2']
  const finalDriver = makeDriver({
    getGridHtml: async () => gridHtml,
    getDetailHtml: async () => detailHtml(ids[detailCallIndex++]),
  })

  const logger = createLogger(LOG_PATH)
  const { db, upsertCalls } = fakeDb()
  await runCollection(
    { driver: finalDriver, db, logger, delay: noDelay, review: async () => 'approve' },
    {
      query: 'headphones',
      softWallTimeoutMs: 100,
    },
  )

  expect(upsertCalls).toHaveLength(2)
  expect(upsertCalls[0][0]).toBe('1')
  expect(upsertCalls[1][0]).toBe('2')
})

test('listing outside the 80km Manila service area is auto-rejected without review or save', async () => {
  const gridHtml = `<script type="application/json">{"results":[
    {"id":"1","marketplace_listing_title":"Mic A"},
    {"id":"2","marketplace_listing_title":"Mic B"}
  ]}</script>`
  // id 1: Cebu City coords, ~570km from Manila. id 2: no location, i.e. within range.
  const detailHtml = (id: string) =>
    id === '1'
      ? `<script type="application/json">{"id":"1","marketplace_listing_title":"Mic","location":{"latitude":10.3157,"longitude":123.8854}}</script>`
      : `<script type="application/json">{"id":"2","marketplace_listing_title":"Mic"}</script>`

  let detailCallIndex = 0
  const ids = ['1', '2']
  const driver = makeDriver({
    getGridHtml: async () => gridHtml,
    getDetailHtml: async () => detailHtml(ids[detailCallIndex++]),
  })

  const logger = createLogger(LOG_PATH)
  const { db, upsertCalls } = fakeDb()
  let reviewCalls = 0
  await runCollection(
    {
      driver,
      db,
      logger,
      delay: noDelay,
      review: async () => {
        reviewCalls += 1
        return 'approve'
      },
    },
    { query: 'headphones', softWallTimeoutMs: 100 },
  )

  expect(reviewCalls).toBe(1)
  expect(upsertCalls).toHaveLength(1)
  expect(upsertCalls[0][0]).toBe('2')
  const logText = readFileSync(LOG_PATH, 'utf-8')
  expect(logText).toContain('rejected listing 1: outside 80km Manila service area')
})

test('"stop" decision ends the run without processing remaining items', async () => {
  const gridHtml = `<script type="application/json">{"results":[
    {"id":"1","marketplace_listing_title":"Mic A"},
    {"id":"2","marketplace_listing_title":"Mic B"}
  ]}</script>`
  const detailHtml = `<script type="application/json">{"id":"1","marketplace_listing_title":"Mic"}</script>`

  const driver = makeDriver({
    getGridHtml: async () => gridHtml,
    getDetailHtml: async () => detailHtml,
  })
  const logger = createLogger(LOG_PATH)
  const { db, upsertCalls } = fakeDb()

  await runCollection(
    { driver, db, logger, delay: noDelay, review: async () => 'stop' },
    {
      query: 'headphones',
      softWallTimeoutMs: 100,
    },
  )

  expect(upsertCalls).toHaveLength(0)
})

test('hard-block page state fails closed and stops the run', async () => {
  const gridHtml = `<script type="application/json">{"results":[
    {"id":"1","marketplace_listing_title":"Mic A"}
  ]}</script>`
  const hardBlockDetailHtml = `<div class="checkpoint_challenge">captcha</div>`

  const driver = makeDriver({
    getGridHtml: async () => gridHtml,
    getDetailHtml: async () => hardBlockDetailHtml,
  })
  const logger = createLogger(LOG_PATH)
  const { db, upsertCalls } = fakeDb()

  await runCollection(
    { driver, db, logger, delay: noDelay, review: async () => 'approve' },
    {
      query: 'headphones',
      softWallTimeoutMs: 100,
    },
  )

  expect(upsertCalls).toHaveLength(0)
  const logText = readFileSync(LOG_PATH, 'utf-8')
  expect(logText).toContain('[ERROR]')
})

test('resolvePageState tags the stop reason so callers can distinguish a real block from a persisted soft-wall', async () => {
  const driver = makeDriver({ refresh: async () => {} })
  const logger = createLogger(LOG_PATH)

  const hardBlock = await resolvePageState(
    { driver, logger, delay: noDelay },
    { fetchHtml: async () => `<div class="checkpoint_challenge">captcha</div>`, hasContent: () => false },
    10,
  )
  expect(hardBlock).toEqual({ status: 'stop', reason: 'hard-block' })

  const softWallPersisted = await resolvePageState(
    { driver, logger, delay: noDelay },
    { fetchHtml: async () => `<div class="login_form">log in</div>`, hasContent: () => false },
    10,
  )
  expect(softWallPersisted).toEqual({ status: 'stop', reason: 'soft-wall-persisted' })
})

test('resolvePageState waits the soft-wall timeout through the injected delay before refreshing', async () => {
  const waits: number[] = []
  const driver = makeDriver({ refresh: async () => {} })
  await resolvePageState(
    {
      driver,
      logger: createLogger(LOG_PATH),
      delay: async (ms) => {
        waits.push(ms)
      },
    },
    { fetchHtml: async () => `<div class="login_form">log in</div>`, hasContent: () => false },
    45000,
  )
  expect(waits).toEqual([45000])
})

test('soft-wall on detail page recovers via refresh and extracts post-refresh content', async () => {
  const gridHtml = `<script type="application/json">{"results":[
    {"id":"1","marketplace_listing_title":"Mic A"}
  ]}</script>`
  const softWallHtml = `<div class="login_form">You must log in to continue</div>`
  const realDetailHtml = `<script type="application/json">{"id":"1","marketplace_listing_title":"Real Mic"}</script>`

  let refreshCalled = false
  let detailCallIndex = 0
  const detailResponses = [softWallHtml, realDetailHtml]

  const driver = makeDriver({
    getGridHtml: async () => gridHtml,
    getDetailHtml: async () => detailResponses[detailCallIndex++],
    refresh: async () => {
      refreshCalled = true
    },
  })
  const logger = createLogger(LOG_PATH)
  const { db, upsertCalls } = fakeDb()

  await runCollection(
    { driver, db, logger, delay: noDelay, review: async () => 'approve' },
    {
      query: 'headphones',
      softWallTimeoutMs: 10,
    },
  )

  expect(refreshCalled).toBe(true)
  expect(detailCallIndex).toBe(2)
  expect(upsertCalls).toHaveLength(1)
  expect(upsertCalls[0][0]).toBe('1')
  expect(upsertCalls[0][1]).toBe('Real Mic')
})

test('paginates for more items when maxItems exceeds first batch, deduping by id', async () => {
  const gridHtml = `<script type="application/json">{"results":[{"id":"1","marketplace_listing_title":"Mic A"}]}</script>
<script type="application/json">{"require":[["LSD",[],{"token":"tok123"}]]}</script>
<script type="application/json">{"data":{"marketplace_search":{"feed_units":{"edges":[],"page_info":{"end_cursor":"{\\"pg\\":0,\\"c2c\\":{\\"br\\":\\"x\\"}}","has_next_page":true}}}}}</script>`
  const detailHtml = (id: string) =>
    `<script type="application/json">{"id":"${id}","marketplace_listing_title":"Mic"}</script>`
  const paginationResponse = JSON.stringify({
    data: {
      marketplace_search: {
        feed_units: {
          edges: [{ node: { story_key: 's2', listing: { id: '2', marketplace_listing_title: 'Mic B' } } }],
          page_info: { end_cursor: '{"pg":1,"c2c":{"br":"y"}}', has_next_page: false },
        },
      },
    },
  })

  let currentListingId = ''
  const driver: PageDriver = {
    gotoSearch: async () => {},
    getGridHtml: async () => gridHtml,
    openListing: async (listing) => {
      currentListingId = listing.id
    },
    getDetailHtml: async () => detailHtml(currentListingId),
    refresh: async () => {},
    waitRandom: async () => {},
    fetchNextPage: async () => paginationResponse,
  }
  const logger = createLogger(LOG_PATH)
  const { db, upsertCalls } = fakeDb()

  await runCollection(
    { driver, db, logger, delay: noDelay, review: async () => 'approve' },
    {
      query: 'headphones',
      softWallTimeoutMs: 100,
      maxItems: 2,
    },
  )

  expect(upsertCalls.map((c) => c[0])).toEqual(['1', '2'])
})

test('clamps to the hard 1000-item limit even when maxItems requests more', async () => {
  const gridHtml = `<script type="application/json">{"results":[{"id":"grid-1","marketplace_listing_title":"Mic"}]}</script>
<script type="application/json">{"require":[["LSD",[],{"token":"tok123"}]]}</script>
<script type="application/json">{"data":{"marketplace_search":{"feed_units":{"edges":[],"page_info":{"end_cursor":"{\\"pg\\":0,\\"c2c\\":{\\"br\\":\\"x\\"}}","has_next_page":true}}}}}</script>`

  let pageNum = 0
  const driver: PageDriver = {
    gotoSearch: async () => {},
    getGridHtml: async () => gridHtml,
    openListing: async () => {},
    getDetailHtml: async () =>
      `<script type="application/json">{"id":"grid-1","marketplace_listing_title":"Mic"}</script>`,
    refresh: async () => {},
    waitRandom: async () => {},
    fetchNextPage: async () => {
      pageNum += 1
      const edges = Array.from({ length: 24 }, (_, i) => ({
        node: { story_key: `s${pageNum}-${i}`, listing: { id: `p${pageNum}-${i}`, marketplace_listing_title: 'Mic' } },
      }))
      return JSON.stringify({
        data: {
          marketplace_search: {
            feed_units: {
              edges,
              page_info: { end_cursor: `{"pg":${pageNum},"c2c":{"br":"x"}}`, has_next_page: true },
            },
          },
        },
      })
    },
  }
  const logger = createLogger(LOG_PATH)
  const { db, upsertCalls } = fakeDb()

  await runCollection(
    { driver, db, logger, delay: noDelay, review: async () => 'approve' },
    {
      query: 'headphones',
      softWallTimeoutMs: 100,
      maxItems: 2000,
    },
  )

  // The "exceeds hard limit" warning itself isn't checked here - it's
  // logged once up front, then evicted by the log file's own MAX_LOG_LINES
  // cap (logger.ts) once 1000 "saved listing" lines pile up after it. The
  // upsertCalls count above is the real proof the clamp took effect.
  expect(upsertCalls).toHaveLength(1000)
})

test('tolerates an empty pagination page and recovers real items from the next one', async () => {
  const gridHtml = `<script type="application/json">{"results":[{"id":"1","marketplace_listing_title":"Mic A"}]}</script>
<script type="application/json">{"require":[["LSD",[],{"token":"tok123"}]]}</script>
<script type="application/json">{"data":{"marketplace_search":{"feed_units":{"edges":[],"page_info":{"end_cursor":"{\\"pg\\":0,\\"c2c\\":{\\"br\\":\\"x\\"}}","has_next_page":true}}}}}</script>`
  const detailHtml = (id: string) =>
    `<script type="application/json">{"id":"${id}","marketplace_listing_title":"Mic"}</script>`

  const emptyPageResponse = JSON.stringify({
    data: {
      marketplace_search: {
        feed_units: {
          edges: [],
          page_info: { end_cursor: '{"pg":1,"c2c":{"br":"y"}}', has_next_page: true },
        },
      },
    },
  })
  const realPageResponse = JSON.stringify({
    data: {
      marketplace_search: {
        feed_units: {
          edges: [{ node: { story_key: 's2', listing: { id: '2', marketplace_listing_title: 'Mic B' } } }],
          page_info: { end_cursor: '{"pg":2,"c2c":{"br":"z"}}', has_next_page: false },
        },
      },
    },
  })
  const paginationResponses = [emptyPageResponse, realPageResponse]
  let paginationCallIndex = 0

  let currentListingId = ''
  const driver: PageDriver = {
    gotoSearch: async () => {},
    getGridHtml: async () => gridHtml,
    openListing: async (listing) => {
      currentListingId = listing.id
    },
    getDetailHtml: async () => detailHtml(currentListingId),
    refresh: async () => {},
    waitRandom: async () => {},
    fetchNextPage: async () => paginationResponses[paginationCallIndex++],
  }
  const logger = createLogger(LOG_PATH)
  const { db, upsertCalls } = fakeDb()

  await runCollection(
    { driver, db, logger, delay: noDelay, review: async () => 'approve' },
    {
      query: 'headphones',
      softWallTimeoutMs: 100,
      maxItems: 2,
    },
  )

  expect(paginationCallIndex).toBe(2)
  expect(upsertCalls.map((c) => c[0])).toEqual(['1', '2'])
})

const PAGINATED_GRID_HTML = `<script type="application/json">{"results":[{"id":"1","marketplace_listing_title":"Mic A"}]}</script>
<script type="application/json">{"require":[["LSD",[],{"token":"tok123"}]]}</script>
<script type="application/json">{"data":{"marketplace_search":{"feed_units":{"edges":[],"page_info":{"end_cursor":"{\\"pg\\":0,\\"c2c\\":{\\"br\\":\\"x\\"}}","has_next_page":true}}}}}</script>`

function paginatedDriver(fetchNextPage: PageDriver['fetchNextPage']): PageDriver {
  let currentListingId = ''
  return makeDriver({
    getGridHtml: async () => PAGINATED_GRID_HTML,
    openListing: async (listing) => {
      currentListingId = listing.id
    },
    getDetailHtml: async () =>
      `<script type="application/json">{"id":"${currentListingId}","marketplace_listing_title":"Mic"}</script>`,
    fetchNextPage,
  })
}

test('stops paginating after three pages in a row bring no new items', async () => {
  let pageNum = 0
  const driver = paginatedDriver(async () => {
    pageNum += 1
    return JSON.stringify({
      data: {
        marketplace_search: {
          feed_units: {
            edges: [{ node: { story_key: `s${pageNum}`, listing: { id: '1', marketplace_listing_title: 'Mic A' } } }],
            page_info: { end_cursor: `{"pg":${pageNum},"c2c":{"br":"x"}}`, has_next_page: true },
          },
        },
      },
    })
  })
  const { db, upsertCalls } = fakeDb()

  await runCollection(
    { driver, db, logger: createLogger(LOG_PATH), delay: noDelay, review: async () => 'approve' },
    { query: 'headphones', softWallTimeoutMs: 100, maxItems: 5 },
  )

  expect(pageNum).toBe(3)
  expect(upsertCalls.map((c) => c[0])).toEqual(['1'])
})

test('stops paginating on an unrecognized pagination response but keeps what it already saved', async () => {
  let calls = 0
  const driver = paginatedDriver(async () => {
    calls += 1
    return '{"unexpected":true}'
  })
  const { db, upsertCalls } = fakeDb()

  await runCollection(
    { driver, db, logger: createLogger(LOG_PATH), delay: noDelay, review: async () => 'approve' },
    { query: 'headphones', softWallTimeoutMs: 100, maxItems: 5 },
  )

  expect(calls).toBe(1)
  expect(upsertCalls.map((c) => c[0])).toEqual(['1'])
})

test('a stop decision on a paginated item ends the run without fetching further pages', async () => {
  let calls = 0
  const driver = paginatedDriver(async () => {
    calls += 1
    return JSON.stringify({
      data: {
        marketplace_search: {
          feed_units: {
            edges: [
              { node: { story_key: `s${calls}`, listing: { id: `p${calls}`, marketplace_listing_title: 'Mic' } } },
            ],
            page_info: { end_cursor: `{"pg":${calls},"c2c":{"br":"x"}}`, has_next_page: true },
          },
        },
      },
    })
  })
  const { db, upsertCalls } = fakeDb()
  const review = async (listing: Record<string, unknown>): Promise<ReviewDecision> =>
    listing.id === 'p1' ? 'stop' : 'approve'

  await runCollection(
    { driver, db, logger: createLogger(LOG_PATH), delay: noDelay, review },
    { query: 'headphones', softWallTimeoutMs: 100, maxItems: 5 },
  )

  expect(calls).toBe(1)
  expect(upsertCalls.map((c) => c[0])).toEqual(['1'])
})

test('skips listings Postgres already has from a prior run', async () => {
  const gridHtml = `<script type="application/json">{"results":[
    {"id":"1","marketplace_listing_title":"Mic A"},
    {"id":"2","marketplace_listing_title":"Mic B"}
  ]}</script>`
  const detailHtml = (id: string) =>
    `<script type="application/json">{"id":"${id}","marketplace_listing_title":"Mic"}</script>`

  let currentListingId = ''
  const openedIds: string[] = []
  const driver: PageDriver = {
    gotoSearch: async () => {},
    getGridHtml: async () => gridHtml,
    openListing: async (listing) => {
      currentListingId = listing.id
      openedIds.push(listing.id)
    },
    getDetailHtml: async () => detailHtml(currentListingId),
    refresh: async () => {},
    waitRandom: async () => {},
    fetchNextPage: async () => '{}',
  }
  const logger = createLogger(LOG_PATH)
  const { db, upsertCalls } = fakeDb(['1'])

  await runCollection(
    { driver, db, logger, delay: noDelay, review: async () => 'approve' },
    {
      query: 'headphones',
      softWallTimeoutMs: 100,
    },
  )

  expect(openedIds).toEqual(['2'])
  expect(upsertCalls.map((c) => c[0])).toEqual(['2'])
})

test('resuming after a crash processes a fresh maxItems budget of new items, on top of what is already saved', async () => {
  const gridHtml = `<script type="application/json">{"results":[
    {"id":"1","marketplace_listing_title":"Mic A"},
    {"id":"2","marketplace_listing_title":"Mic B"},
    {"id":"3","marketplace_listing_title":"Mic C"},
    {"id":"4","marketplace_listing_title":"Mic D"},
    {"id":"5","marketplace_listing_title":"Mic E"}
  ]}</script>`
  const detailHtml = (id: string) =>
    `<script type="application/json">{"id":"${id}","marketplace_listing_title":"Mic"}</script>`

  let currentListingId = ''
  const openedIds: string[] = []
  const driver: PageDriver = {
    gotoSearch: async () => {},
    getGridHtml: async () => gridHtml,
    openListing: async (listing) => {
      currentListingId = listing.id
      openedIds.push(listing.id)
    },
    getDetailHtml: async () => detailHtml(currentListingId),
    refresh: async () => {},
    waitRandom: async () => {},
    fetchNextPage: async () => '{}',
  }
  const logger = createLogger(LOG_PATH)
  // Simulate a prior run that already saved listings 1 and 2 before crashing.
  const { db, upsertCalls } = fakeDb(['1', '2'])

  // maxItems is a per-run budget of NEW items, not a lifetime total: 1 and 2 are
  // already saved and get skipped via dedup regardless, then 3 more new ones
  // (3, 4, 5) get processed to fill the budget.
  await runCollection(
    { driver, db, logger, delay: noDelay, review: async () => 'approve' },
    {
      query: 'headphones',
      softWallTimeoutMs: 100,
      maxItems: 3,
    },
  )

  expect(openedIds).toEqual(['3', '4', '5'])
  expect(upsertCalls.map((c) => c[0])).toEqual(['3', '4', '5'])
})

test('when an image store is provided, downloads and re-hosts the photo carousel before saving', async () => {
  const gridHtml = `<script type="application/json">{"results":[
    {"id":"1","marketplace_listing_title":"Mic A"}
  ]}</script>`
  const detailHtml = `<script type="application/json">{
    "id":"1","marketplace_listing_title":"Mic A",
    "listing_photos":[{"image":{"uri":"https://cdn.example.com/a.jpg"}}]
  }</script>`
  const driver = makeDriver({
    getGridHtml: async () => gridHtml,
    getDetailHtml: async () => detailHtml,
  })
  const logger = createLogger(LOG_PATH)
  const puts: string[] = []
  const imageStore = {
    put: async (key: string) => {
      puts.push(key)
      return `https://images.example.com/${key}`
    },
    deleteAll: async () => {},
    list: async () => [],
    delete: async () => {},
  }
  const photos = createListingPhotos({
    store: imageStore,
    fetchBytes: async () => ({ body: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' }),
    compress: async (body, contentType) => ({ body, contentType }),
    logger,
  })

  const { db, upsertCalls } = fakeDb()
  await runCollection(
    { driver, db, logger, delay: noDelay, review: async () => 'approve', photos },
    { query: 'headphones', softWallTimeoutMs: 100 },
  )

  expect(puts).toEqual(['listings/1/0.jpg'])
  const storedPhotoUrls = upsertCalls[0][11] as string
  expect(JSON.parse(storedPhotoUrls)).toEqual(['https://images.example.com/listings/1/0.jpg'])
})
