import { Readable, Writable } from 'node:stream'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import type { PageDriver } from '../src/driver'
import type { GridListing } from '../src/extract/grid'
import { runCollection } from '../src/run'
import { createLogger } from '../src/logger'

const OUT_PATH = 'test/tmp-run-listings.jsonl'
const LOG_PATH = 'test/tmp-run.log'

afterEach(() => {
  for (const p of [OUT_PATH, LOG_PATH]) if (existsSync(p)) rmSync(p)
})

function mockInput(...lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + '\n').join(''))
}

function silentOutput(): Writable {
  return new Writable({ write(_c, _e, cb) { cb() } })
}

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

test('approved item gets saved, then loop advances to next item', async () => {
  const grid: GridListing[] = [
    { id: '1', marketplace_listing_title: 'Mic A' },
    { id: '2', marketplace_listing_title: 'Mic B' },
  ]
  const driver = makeDriver({
    getGridHtml: async () =>
      `<script type="application/json"><![CDATA[]]></script>`, // overridden below via monkeypatch
  })
  // Simplify: directly stub extractGridListings behavior by controlling getGridHtml + getDetailHtml content
  // using real fixture-shaped JSON so extractGridListings/extractDetailFields parse it for real.
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
  await runCollection(
    finalDriver,
    logger,
    async () => 'approve',
    mockInput(),
    silentOutput(),
    { query: 'headphones', outputPath: OUT_PATH, softWallTimeoutMs: 100 },
  )

  const saved = readFileSync(OUT_PATH, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
  expect(saved).toHaveLength(2)
  expect(saved[0].id).toBe('1')
  expect(saved[1].id).toBe('2')
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

  await runCollection(
    driver,
    logger,
    async () => 'stop',
    mockInput(),
    silentOutput(),
    { query: 'headphones', outputPath: OUT_PATH, softWallTimeoutMs: 100 },
  )

  expect(existsSync(OUT_PATH)).toBe(false)
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

  await runCollection(
    driver,
    logger,
    async () => 'approve',
    mockInput(),
    silentOutput(),
    { query: 'headphones', outputPath: OUT_PATH, softWallTimeoutMs: 100 },
  )

  expect(existsSync(OUT_PATH)).toBe(false)
  const logText = readFileSync(LOG_PATH, 'utf-8')
  expect(logText).toContain('[ERROR]')
})

test('soft-wall on detail page recovers via refresh and extracts post-refresh content', async () => {
  const gridHtml = `<script type="application/json">{"results":[
    {"id":"1","marketplace_listing_title":"Mic A"}
  ]}</script>`
  const softWallHtml = `<div class="login_form">You must log in to continue</div>`
  const realDetailHtml = `<script type="application/json">{"id":"1","marketplace_listing_title":"Real Mic","condition":"Used"}</script>`

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

  await runCollection(
    driver,
    logger,
    async () => 'approve',
    mockInput(),
    silentOutput(),
    { query: 'headphones', outputPath: OUT_PATH, softWallTimeoutMs: 10 },
  )

  expect(refreshCalled).toBe(true)
  expect(detailCallIndex).toBe(2)

  const saved = readFileSync(OUT_PATH, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
  expect(saved).toHaveLength(1)
  expect(saved[0].marketplace_listing_title).toBe('Real Mic')
  expect(saved[0].condition).toBe('Used')
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

  await runCollection(driver, logger, async () => 'approve', mockInput(), silentOutput(), {
    query: 'headphones',
    outputPath: OUT_PATH,
    softWallTimeoutMs: 100,
    maxItems: 2,
  })

  const saved = readFileSync(OUT_PATH, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
  expect(saved.map((s) => s.id)).toEqual(['1', '2'])
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

  await runCollection(driver, logger, async () => 'approve', mockInput(), silentOutput(), {
    query: 'headphones',
    outputPath: OUT_PATH,
    softWallTimeoutMs: 100,
    maxItems: 2,
  })

  expect(paginationCallIndex).toBe(2)
  const saved = readFileSync(OUT_PATH, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
  expect(saved.map((s) => s.id)).toEqual(['1', '2'])
})
