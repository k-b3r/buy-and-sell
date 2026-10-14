import type { PageIo } from './driver'
import { detectPageState } from './wall'
import { extractDetailFields } from './extract/detail'

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
