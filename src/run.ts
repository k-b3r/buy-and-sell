import { writeFileSync } from 'node:fs'
import type { PageDriver } from './driver'
import type { Logger } from './logger'
import type { ReviewDecision } from './review'
import { detectPageState } from './wall'
import { extractGridListings, looksLikeListing } from './extract/grid'
import { extractDetailFields } from './extract/detail'
import { appendApprovedListing } from './output'
import { extractCursor, extractLsd, parsePaginationResponse } from './paginate'

function dumpDebugHtml(html: string): void {
  const path = `data/debug-${Date.now()}.html`
  writeFileSync(path, html)
}

export interface RunOptions {
  query: string
  outputPath: string
  softWallTimeoutMs: number
  maxItems?: number
}

type ReviewFn = (
  listing: Record<string, unknown>,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
) => Promise<ReviewDecision>

type PageStateResult = { status: 'ok'; html: string } | { status: 'stop' }

async function resolvePageState(
  driver: PageDriver,
  logger: Logger,
  fetchHtml: () => Promise<string>,
  softWallTimeoutMs: number,
  hasContent: (html: string) => boolean,
): Promise<PageStateResult> {
  let html = await fetchHtml()
  if (hasContent(html)) return { status: 'ok', html }

  let state = detectPageState(html)
  if (state === 'normal') return { status: 'ok', html }

  if (state === 'soft-wall') {
    logger.warn('soft login-wall detected, waiting for manual refresh or auto-refresh fallback')
    await new Promise((resolve) => setTimeout(resolve, softWallTimeoutMs))
    await driver.refresh()
    html = await fetchHtml()
    if (hasContent(html)) return { status: 'ok', html }
    state = detectPageState(html)
    if (state === 'normal') return { status: 'ok', html }
    if (state === 'soft-wall') {
      dumpDebugHtml(html)
      logger.error('soft login-wall persisted after refresh, failing closed and stopping run — html dumped for inspection')
      return { status: 'stop' }
    }
  }

  dumpDebugHtml(html)
  logger.error(`unrecognized page state "${state}", failing closed and stopping run — html dumped for inspection`)
  return { status: 'stop' }
}

export async function runCollection(
  driver: PageDriver,
  logger: Logger,
  review: ReviewFn,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  options: RunOptions,
): Promise<void> {
  logger.info(`starting run: query="${options.query}"`)
  await driver.gotoSearch(options.query)

  const gridResult = await resolvePageState(
    driver,
    logger,
    () => driver.getGridHtml(),
    options.softWallTimeoutMs,
    (html) => extractGridListings(html).length > 0,
  )
  if (gridResult.status === 'stop') return

  const seen = new Set<string>()
  const listings = extractGridListings(gridResult.html).filter((l) => {
    if (seen.has(l.id)) return false
    seen.add(l.id)
    return true
  })
  logger.info(`found ${listings.length} listings in search grid`)

  const maxItems = options.maxItems ?? listings.length
  let cursor = extractCursor(gridResult.html)
  let hasNextPage = true
  const MAX_PAGES = 20
  let pageCount = 0
  while (listings.length < maxItems && cursor && hasNextPage) {
    pageCount += 1
    if (pageCount > MAX_PAGES) {
      logger.warn('pagination page limit reached, stopping')
      break
    }
    const lsd = extractLsd(gridResult.html)
    if (!lsd) {
      logger.error('no lsd token found for pagination, stopping')
      break
    }
    await driver.waitRandom(4000, 10000)
    const raw = await driver.fetchNextPage(cursor, lsd, options.query)
    const page = parsePaginationResponse(raw)
    if (!page) {
      logger.error('unrecognized pagination response shape, failing closed and stopping pagination')
      break
    }
    let skipped = 0
    const before = listings.length
    for (const node of page.nodes) {
      if (!looksLikeListing(node)) {
        skipped += 1
        continue
      }
      const id = node.id as string
      if (!seen.has(id)) {
        seen.add(id)
        listings.push(node as (typeof listings)[number])
      }
    }
    if (skipped > 0) {
      logger.info(`skipped ${skipped} pagination nodes with unrecognized shape`)
    }
    if (listings.length > maxItems) {
      listings.length = maxItems
    }
    logger.info(`paginated: now have ${listings.length} listings (page ${cursor.pg} -> ${page.nextCursor?.pg ?? '?'})`)
    if (listings.length === before) {
      logger.info('pagination made no progress, stopping')
      break
    }
    cursor = page.nextCursor
    hasNextPage = page.hasNextPage
  }

  for (const listing of listings) {
    await driver.openListing(listing)
    await driver.waitRandom(4000, 10000)

    const detailResult = await resolvePageState(
      driver,
      logger,
      () => driver.getDetailHtml(),
      options.softWallTimeoutMs,
      (html) => Object.keys(extractDetailFields(html)).length > 0,
    )
    if (detailResult.status === 'stop') return

    const detail = extractDetailFields(detailResult.html)
    const merged = { ...listing, ...detail }

    const decision = await review(merged, input, output)
    if (decision === 'stop') {
      logger.info('user stopped run')
      return
    }
    if (decision === 'approve') {
      appendApprovedListing(options.outputPath, merged)
      logger.info(`saved listing ${merged.id}`)
    } else {
      logger.info(`rejected listing ${merged.id}`)
    }
  }

  logger.info('run complete')
}
