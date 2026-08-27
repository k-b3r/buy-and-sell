import { writeFileSync, mkdirSync } from 'node:fs'
import type { PageDriver } from './driver'
import type { Logger } from './logger'
import type { ReviewDecision } from './review'
import { detectPageState } from './wall'
import { extractGridListings, looksLikeListing } from './extract/grid'
import { extractDetailFields } from './extract/detail'
import { extractCursor, extractLsd, parsePaginationResponse } from './paginate'
import type { DbClient } from './storage/client'
import { upsertListing, getCollectedListingIds } from './workers/cli/storage'
import type { ImageStore } from './images'
import { storeListingPhotos } from './images'

// Diagnostic-only, never allowed to take down the caller - confirmed live
// 2026-08-24: refresh-server.ts runs with CWD=server/ (no data/ dir there,
// unlike the root CLI scripts' convention), and the missing directory
// crashed the entire long-lived HTTP process uncaught, not just this one
// request. mkdir handles the expected case; the catch is defense-in-depth
// for anything else (disk full, permissions) that shouldn't be fatal either.
function dumpDebugHtml(html: string): void {
  try {
    mkdirSync('data', { recursive: true })
    writeFileSync(`data/debug-${Date.now()}.html`, html)
  } catch (err) {
    console.error('dumpDebugHtml failed, continuing without the debug dump:', err)
  }
}

export interface RunOptions {
  query: string
  softWallTimeoutMs: number
  maxItems?: number
  daysSinceListed?: number
}

type ReviewFn = (
  listing: Record<string, unknown>,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
) => Promise<ReviewDecision>

type PageStateResult =
  | { status: 'ok'; html: string }
  | { status: 'stop'; reason: 'soft-wall-persisted' | 'hard-block' | 'unrecognized' }

export async function resolvePageState(
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
      return { status: 'stop', reason: 'soft-wall-persisted' }
    }
  }

  dumpDebugHtml(html)
  logger.error(`unrecognized page state "${state}", failing closed and stopping run — html dumped for inspection`)
  return { status: 'stop', reason: state === 'hard-block' ? 'hard-block' : 'unrecognized' }
}

export async function runCollection(
  driver: PageDriver,
  logger: Logger,
  review: ReviewFn,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  options: RunOptions,
  db: DbClient,
  imageStore?: ImageStore,
): Promise<void> {
  const daysSinceListed = options.daysSinceListed ?? 30
  logger.info(`starting run: query="${options.query}", daysSinceListed=${daysSinceListed}`)
  await driver.gotoSearch(options.query, daysSinceListed)

  const gridResult = await resolvePageState(
    driver,
    logger,
    () => driver.getGridHtml(),
    options.softWallTimeoutMs,
    (html) => extractGridListings(html).length > 0,
  )
  if (gridResult.status === 'stop') return

  const persistedIds = await getCollectedListingIds(db)
  const seen = new Set<string>(persistedIds)
  const rawGridListings = extractGridListings(gridResult.html)
  const alreadyCollected = rawGridListings.filter((l) => persistedIds.has(l.id)).length
  const firstBatch = rawGridListings.filter((l) => {
    if (seen.has(l.id)) return false
    seen.add(l.id)
    return true
  })
  logger.info(
    `found ${rawGridListings.length} listings in search grid (${alreadyCollected} already collected previously, ${firstBatch.length} new)`,
  )

  const HARD_MAX_ITEMS = 1000
  if (options.maxItems !== undefined && options.maxItems > HARD_MAX_ITEMS) {
    logger.warn(`requested maxItems ${options.maxItems} exceeds hard limit ${HARD_MAX_ITEMS}, clamping`)
  }
  // maxItems is new-items-to-collect-this-run, not a lifetime total. Already-saved
  // IDs (from any prior run, any query, any machine — Postgres is shared) are
  // skipped via dedup above regardless, so re-running the same command after a
  // crash naturally continues rather than re-processing what's already saved.
  const maxItems = options.maxItems !== undefined ? Math.min(options.maxItems, HARD_MAX_ITEMS) : firstBatch.length
  if (firstBatch.length > maxItems) {
    firstBatch.length = maxItems
  }

  // Process one page's items (open -> review -> save) before ever fetching the
  // next page. Interleaving page-fetch and item-processing this way mimics
  // real browsing (scroll a bit, open some, scroll more) instead of firing
  // many uniform pagination-only requests back to back.
  async function processBatch(items: ReturnType<typeof extractGridListings>): Promise<'stop' | 'continue'> {
    for (const listing of items) {
      await driver.openListing(listing)
      await driver.waitRandom(4000, 10000)

      const detailResult = await resolvePageState(
        driver,
        logger,
        () => driver.getDetailHtml(),
        options.softWallTimeoutMs,
        (html) => Object.keys(extractDetailFields(html)).length > 0,
      )
      if (detailResult.status === 'stop') return 'stop'

      const detail = extractDetailFields(detailResult.html)
      const merged = { ...listing, ...detail }

      const decision = await review(merged, input, output)
      if (decision === 'stop') {
        logger.info('user stopped run')
        return 'stop'
      }
      if (decision === 'approve') {
        if (imageStore) {
          const photoUrls = await storeListingPhotos(imageStore, logger, String(merged.id), merged.listing_photos)
          if (photoUrls.length > 0) {
            merged.stored_photo_urls = photoUrls
          }
        }
        await upsertListing(db, merged)
        logger.info(`saved listing ${merged.id}`)
      } else {
        logger.info(`rejected listing ${merged.id}`)
      }
    }
    return 'continue'
  }

  if (await processBatch(firstBatch) === 'stop') return
  let processedCount = firstBatch.length

  let cursor = extractCursor(gridResult.html)
  let hasNextPage = true
  const MAX_PAGES = 60
  const MAX_CONSECUTIVE_EMPTY_PAGES = 3
  let pageCount = 0
  let consecutiveEmptyPages = 0
  while (processedCount < maxItems && cursor && hasNextPage) {
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
    const newItems: ReturnType<typeof extractGridListings> = []
    for (const node of page.nodes) {
      if (!looksLikeListing(node)) {
        skipped += 1
        continue
      }
      const id = node.id as string
      if (!seen.has(id)) {
        seen.add(id)
        newItems.push(node as (typeof newItems)[number])
      }
    }
    if (skipped > 0) {
      logger.info(`skipped ${skipped} pagination nodes with unrecognized shape`)
    }
    const remaining = maxItems - processedCount
    if (newItems.length > remaining) {
      newItems.length = remaining
    }
    logger.info(
      `page ${cursor.pg} -> ${page.nextCursor?.pg ?? '?'}: ${newItems.length} new listings (${processedCount + newItems.length}/${maxItems} total)`,
    )
    if (newItems.length === 0) {
      consecutiveEmptyPages += 1
      logger.info(
        `pagination page returned no new items (${consecutiveEmptyPages}/${MAX_CONSECUTIVE_EMPTY_PAGES} tolerated in a row)`,
      )
      if (consecutiveEmptyPages >= MAX_CONSECUTIVE_EMPTY_PAGES) {
        logger.info('too many consecutive empty pages, stopping')
        break
      }
    } else {
      consecutiveEmptyPages = 0
      if (await processBatch(newItems) === 'stop') return
      processedCount += newItems.length
    }
    cursor = page.nextCursor
    hasNextPage = page.hasNextPage
  }

  logger.info('run complete')
}
