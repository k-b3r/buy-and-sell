import type { PageDriver } from './driver'
import type { Logger } from './logger'
import type { ReviewDecision } from './review'
import { detectPageState } from './wall'
import { extractGridListings } from './extract/grid'
import { extractDetailFields } from './extract/detail'
import { appendApprovedListing } from './output'

export interface RunOptions {
  query: string
  location: string
  outputPath: string
  softWallTimeoutMs: number
}

type ReviewFn = (
  listing: Record<string, unknown>,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
) => Promise<ReviewDecision>

async function handlePageState(
  driver: PageDriver,
  logger: Logger,
  html: string,
  softWallTimeoutMs: number,
): Promise<'ok' | 'stop'> {
  const state = detectPageState(html)
  if (state === 'normal') return 'ok'

  if (state === 'soft-wall') {
    logger.warn('soft login-wall detected, waiting for manual refresh or auto-refresh fallback')
    await new Promise((resolve) => setTimeout(resolve, softWallTimeoutMs))
    await driver.refresh()
    return 'ok'
  }

  logger.error(`unrecognized page state "${state}", failing closed and stopping run`)
  return 'stop'
}

export async function runCollection(
  driver: PageDriver,
  logger: Logger,
  review: ReviewFn,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  options: RunOptions,
): Promise<void> {
  logger.info(`starting run: query="${options.query}" location="${options.location}"`)
  await driver.gotoSearch(options.query, options.location)

  const gridHtml = await driver.getGridHtml()
  const gridState = await handlePageState(driver, logger, gridHtml, options.softWallTimeoutMs)
  if (gridState === 'stop') return

  const listings = extractGridListings(gridHtml)
  logger.info(`found ${listings.length} listings in search grid`)

  for (const listing of listings) {
    await driver.openListing(listing)
    await driver.waitRandom(4000, 10000)

    const detailHtml = await driver.getDetailHtml()
    const detailState = await handlePageState(driver, logger, detailHtml, options.softWallTimeoutMs)
    if (detailState === 'stop') return

    const detail = extractDetailFields(detailHtml)
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
