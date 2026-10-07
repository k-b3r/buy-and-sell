import type { PageIo } from './driver'
import type { ReviewDecision } from '../../platform/review'
import { detectPageState } from './wall'
import { extractGridListings, looksLikeListing, type GridListing } from './extract/grid'
import { extractDetailFields } from './extract/detail'
import { extractCursor, extractLsd, parsePaginationResponse } from './paginate'
import { isWithinServiceArea, MAX_SERVICE_RADIUS_KM } from './location'
import type { DbClient } from '../../platform/storage'
import { upsertListing, getCollectedListingIds } from './listings'
import type { ListingPhotos } from './photos'

export interface RunOptions {
  query: string
  softWallTimeoutMs: number
  maxItems?: number
  daysSinceListed?: number
  pacingMinMs?: number
  pacingMaxMs?: number
}

export interface CollectionRunIo extends PageIo {
  db: DbClient
  // Approves, rejects or stops on each in-area listing before it is saved.
  review: (listing: Record<string, unknown>) => Promise<ReviewDecision>
  // Without it, listings keep only Facebook's expiring signed photo URLs.
  photos?: ListingPhotos
}

type PageStateResult =
  { status: 'ok'; html: string } | { status: 'stop'; reason: 'soft-wall-persisted' | 'hard-block' | 'unrecognized' }

interface PageRead {
  fetchHtml: () => Promise<string>
  hasContent: (html: string) => boolean
}

export async function resolvePageState(
  { driver, logger, delay }: PageIo,
  { fetchHtml, hasContent }: PageRead,
  softWallTimeoutMs: number,
): Promise<PageStateResult> {
  let html = await fetchHtml()
  if (hasContent(html)) return { status: 'ok', html }

  let state = detectPageState(html)
  if (state === 'normal') return { status: 'ok', html }

  if (state === 'soft-wall') {
    logger.warn('soft login-wall detected, waiting for manual refresh or auto-refresh fallback')
    await delay(softWallTimeoutMs)
    await driver.refresh()
    html = await fetchHtml()
    if (hasContent(html)) return { status: 'ok', html }
    state = detectPageState(html)
    if (state === 'normal') return { status: 'ok', html }
    if (state === 'soft-wall') {
      logger.error('soft login-wall persisted after refresh, failing closed and stopping run')
      return { status: 'stop', reason: 'soft-wall-persisted' }
    }
  }

  logger.error(`unrecognized page state "${state}", failing closed and stopping run`)
  return { status: 'stop', reason: state === 'hard-block' ? 'hard-block' : 'unrecognized' }
}

// A listing detail page counts as loaded once any detail field extracts.
export function resolveDetailPage(io: PageIo, softWallTimeoutMs: number): Promise<PageStateResult> {
  return resolvePageState(
    io,
    {
      fetchHtml: () => io.driver.getDetailHtml(),
      hasContent: (html) => Object.keys(extractDetailFields(html)).length > 0,
    },
    softWallTimeoutMs,
  )
}

const DEFAULT_DAYS_SINCE_LISTED = 30
const DEFAULT_PACING_MIN_MS = 4000
const DEFAULT_PACING_MAX_MS = 10000
const HARD_MAX_ITEMS = 1000
const MAX_PAGES = 60
const MAX_CONSECUTIVE_EMPTY_PAGES = 3

type BatchOutcome = 'stop' | 'continue'

// Per-run state shared by the batch and pagination steps. `seen` grows as
// pages arrive, so no listing is opened twice in one run.
interface RunContext {
  io: CollectionRunIo
  options: RunOptions
  pacingMinMs: number
  pacingMaxMs: number
  maxItems: number
  seen: Set<string>
}

// Keeps the first occurrence of each id not already in `seen`, adding it to `seen`.
function takeUnseen(listings: GridListing[], seen: Set<string>): GridListing[] {
  return listings.filter((l) => {
    if (seen.has(l.id)) return false
    seen.add(l.id)
    return true
  })
}

// Splits pagination nodes into new listings and a count of nodes that don't look like one.
function selectPageListings(nodes: unknown[], seen: Set<string>): { newItems: GridListing[]; skipped: number } {
  const listings = nodes.filter(looksLikeListing) as unknown as GridListing[]
  return { newItems: takeUnseen(listings, seen), skipped: nodes.length - listings.length }
}

// maxItems is new-items-to-collect-this-run, not a lifetime total. Already-saved
// IDs (from any prior run, any query, any machine — Postgres is shared) are
// skipped via dedup regardless, so re-running the same command after a
// crash naturally continues rather than re-processing what's already saved.
function resolveMaxItems({ logger }: CollectionRunIo, requested: number | undefined, firstBatchSize: number): number {
  if (requested === undefined) return firstBatchSize
  if (requested > HARD_MAX_ITEMS) {
    logger.warn(`requested maxItems ${requested} exceeds hard limit ${HARD_MAX_ITEMS}, clamping`)
  }
  return Math.min(requested, HARD_MAX_ITEMS)
}

// Open -> area check -> review -> save, for one grid listing.
async function processListing(ctx: RunContext, listing: GridListing): Promise<BatchOutcome> {
  const { io, options } = ctx
  const { driver, db, logger, review, photos } = io
  await driver.openListing(listing)
  await driver.waitRandom(ctx.pacingMinMs, ctx.pacingMaxMs)

  const detailResult = await resolveDetailPage(io, options.softWallTimeoutMs)
  if (detailResult.status === 'stop') return 'stop'

  const merged: Record<string, unknown> = { ...listing, ...extractDetailFields(detailResult.html) }
  if (!isWithinServiceArea(merged)) {
    logger.info(`rejected listing ${merged.id}: outside ${MAX_SERVICE_RADIUS_KM}km Manila service area`)
    return 'continue'
  }

  const decision = await review(merged)
  if (decision === 'stop') {
    logger.info('user stopped run')
    return 'stop'
  }
  if (decision !== 'approve') {
    logger.info(`rejected listing ${merged.id}`)
    return 'continue'
  }
  if (photos) {
    const photoUrls = await photos.save(String(merged.id), merged.listing_photos)
    if (photoUrls.length > 0) merged.stored_photo_urls = photoUrls
  }
  await upsertListing(db, merged)
  logger.info(`saved listing ${merged.id}`)
  return 'continue'
}

// Process one page's items (open -> review -> save) before ever fetching the
// next page. Interleaving page-fetch and item-processing this way mimics
// real browsing (scroll a bit, open some, scroll more) instead of firing
// many uniform pagination-only requests back to back.
async function processBatch(ctx: RunContext, items: GridListing[]): Promise<BatchOutcome> {
  for (const listing of items) {
    if ((await processListing(ctx, listing)) === 'stop') return 'stop'
  }
  return 'continue'
}

// Fetches pages after the grid until maxItems new listings are processed, the
// feed ends, or a guard trips (page cap, missing token, unknown shape, too
// many empty pages in a row). 'stop' only when a listing step stopped the run.
async function paginate(ctx: RunContext, gridHtml: string, processedSoFar: number): Promise<BatchOutcome> {
  const { io, options, maxItems } = ctx
  const { driver, logger } = io
  let processedCount = processedSoFar
  let cursor = extractCursor(gridHtml)
  let hasNextPage = true
  let pageCount = 0
  let consecutiveEmptyPages = 0
  while (processedCount < maxItems && cursor && hasNextPage) {
    pageCount += 1
    if (pageCount > MAX_PAGES) {
      logger.warn('pagination page limit reached, stopping')
      return 'continue'
    }
    const lsd = extractLsd(gridHtml)
    if (!lsd) {
      logger.error('no lsd token found for pagination, stopping')
      return 'continue'
    }
    await driver.waitRandom(ctx.pacingMinMs, ctx.pacingMaxMs)
    const page = parsePaginationResponse(await driver.fetchNextPage(cursor, lsd, options.query))
    if (!page) {
      logger.error('unrecognized pagination response shape, failing closed and stopping pagination')
      return 'continue'
    }
    const { newItems, skipped } = selectPageListings(page.nodes, ctx.seen)
    if (skipped > 0) logger.info(`skipped ${skipped} pagination nodes with unrecognized shape`)
    newItems.length = Math.min(newItems.length, maxItems - processedCount)
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
        return 'continue'
      }
    } else {
      consecutiveEmptyPages = 0
      if ((await processBatch(ctx, newItems)) === 'stop') return 'stop'
      processedCount += newItems.length
    }
    cursor = page.nextCursor
    hasNextPage = page.hasNextPage
  }
  return 'continue'
}

export async function runCollection(io: CollectionRunIo, options: RunOptions): Promise<void> {
  const { driver, db, logger } = io
  const daysSinceListed = options.daysSinceListed ?? DEFAULT_DAYS_SINCE_LISTED
  logger.info(`starting run: query="${options.query}", daysSinceListed=${daysSinceListed}`)
  await driver.gotoSearch(options.query, daysSinceListed)

  const gridResult = await resolvePageState(
    io,
    { fetchHtml: () => driver.getGridHtml(), hasContent: (html) => extractGridListings(html).length > 0 },
    options.softWallTimeoutMs,
  )
  if (gridResult.status === 'stop') return

  const persistedIds = await getCollectedListingIds(db)
  const seen = new Set<string>(persistedIds)
  const rawGridListings = extractGridListings(gridResult.html)
  const alreadyCollected = rawGridListings.filter((l) => persistedIds.has(l.id)).length
  const firstBatch = takeUnseen(rawGridListings, seen)
  logger.info(
    `found ${rawGridListings.length} listings in search grid (${alreadyCollected} already collected previously, ${firstBatch.length} new)`,
  )

  const maxItems = resolveMaxItems(io, options.maxItems, firstBatch.length)
  firstBatch.length = Math.min(firstBatch.length, maxItems)

  const ctx: RunContext = {
    io,
    options,
    pacingMinMs: options.pacingMinMs ?? DEFAULT_PACING_MIN_MS,
    pacingMaxMs: options.pacingMaxMs ?? DEFAULT_PACING_MAX_MS,
    maxItems,
    seen,
  }
  if ((await processBatch(ctx, firstBatch)) === 'stop') return
  if ((await paginate(ctx, gridResult.html, firstBatch.length)) === 'stop') return
  logger.info('run complete')
}
