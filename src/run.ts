import { writeFileSync } from 'node:fs'
import type { PageDriver } from './driver'
import type { Logger } from './logger'
import type { ReviewDecision } from './review'
import { detectPageState } from './wall'
import { extractGridListings } from './extract/grid'
import { extractDetailFields } from './extract/detail'
import { appendApprovedListing } from './output'

function dumpDebugHtml(html: string): void {
  const path = `data/debug-${Date.now()}.html`
  writeFileSync(path, html)
}

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

type PageStateResult = { status: 'ok'; html: string } | { status: 'stop' }

async function resolvePageState(
  driver: PageDriver,
  logger: Logger,
  fetchHtml: () => Promise<string>,
  softWallTimeoutMs: number,
): Promise<PageStateResult> {
  let html = await fetchHtml()
  let state = detectPageState(html)
  if (state === 'normal') return { status: 'ok', html }

  if (state === 'soft-wall') {
    logger.warn('soft login-wall detected, waiting for manual refresh or auto-refresh fallback')
    await new Promise((resolve) => setTimeout(resolve, softWallTimeoutMs))
    await driver.refresh()
    html = await fetchHtml()
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
  logger.info(`starting run: query="${options.query}" location="${options.location}"`)
  await driver.gotoSearch(options.query, options.location)

  const gridResult = await resolvePageState(
    driver,
    logger,
    () => driver.getGridHtml(),
    options.softWallTimeoutMs,
  )
  if (gridResult.status === 'stop') return

  const listings = extractGridListings(gridResult.html)
  logger.info(`found ${listings.length} listings in search grid`)

  for (const listing of listings) {
    await driver.openListing(listing)
    await driver.waitRandom(4000, 10000)

    const detailResult = await resolvePageState(
      driver,
      logger,
      () => driver.getDetailHtml(),
      options.softWallTimeoutMs,
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
