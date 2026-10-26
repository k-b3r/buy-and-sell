import type { GridListing, GridPage, ListingPhotos, PageIo } from '../../modules/collection'
import {
  getCollectedListingIds,
  isWithinServiceArea,
  MAX_SERVICE_RADIUS_KM,
  readDetailFields,
  readGridPage,
  readNextPage,
  resolveDetailPage,
  resolvePageState,
  upsertListing,
} from '../../modules/collection'
import type { ReviewDecision } from '../../platform/review'
import type { DbClient } from '../../platform/storage'

interface RunOptions {
  query: string
  softWallTimeoutMs: number
  maxItems?: number
  daysSinceListed?: number
  pacingMinMs?: number
  pacingMaxMs?: number
}

interface CollectionRunIo extends PageIo {
  db: DbClient
  // Approves, rejects or stops on each in-area listing before it is saved.
  review: (listing: Record<string, unknown>) => Promise<ReviewDecision>
  // Without it, listings keep only Facebook's expiring signed photo URLs.
  photos?: ListingPhotos
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

  const merged: Record<string, unknown> = { ...listing, ...readDetailFields(detailResult.html) }
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
async function paginate(ctx: RunContext, grid: GridPage, processedSoFar: number): Promise<BatchOutcome> {
  const { io, options, maxItems } = ctx
  const { driver, logger } = io
  let processedCount = processedSoFar
  let cursor = grid.cursor
  let hasNextPage = true
  let pageCount = 0
  let consecutiveEmptyPages = 0
  while (processedCount < maxItems && cursor && hasNextPage) {
    pageCount += 1
    if (pageCount > MAX_PAGES) {
      logger.warn('pagination page limit reached, stopping')
      return 'continue'
    }
    if (!grid.lsd) {
      logger.error('no lsd token found for pagination, stopping')
      return 'continue'
    }
    await driver.waitRandom(ctx.pacingMinMs, ctx.pacingMaxMs)
    const page = readNextPage(await driver.fetchNextPage(cursor, grid.lsd, options.query))
    if (!page) {
      logger.error('unrecognized pagination response shape, failing closed and stopping pagination')
      return 'continue'
    }
    if (page.skipped > 0) logger.info(`skipped ${page.skipped} pagination nodes with unrecognized shape`)
    const newItems = takeUnseen(page.listings, ctx.seen)
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
    { fetchHtml: () => driver.getGridHtml(), hasContent: (html) => readGridPage(html).listings.length > 0 },
    options.softWallTimeoutMs,
  )
  if (gridResult.status === 'stop') return

  const grid = readGridPage(gridResult.html)
  const persistedIds = await getCollectedListingIds(db)
  const seen = new Set<string>(persistedIds)
  const rawGridListings = grid.listings
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
  if ((await paginate(ctx, grid, firstBatch.length)) === 'stop') return
  logger.info('run complete')
}
