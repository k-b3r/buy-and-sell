import type { BrowserDriver, PageDriver } from '../../modules/collection'
import { isBrowserUnusableError } from '../../modules/collection'
import type { DelayFn } from '../../platform/delay'
import type { Logger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import { loadSettings } from '../../platform/settings'
import { loadCollectKeywords, loadRealEstateKeywords, planLapQueries } from '../../platform/collect-keywords'
import type { LapQuery } from '../../platform/collect-keywords'

// collect's loop, kept out of platform/worker.ts's runWorker on purpose: it
// runs once by default and loops only with --cycle, logs its laps differently,
// paces test runs on its own, and can stop itself after repeated failures.

// Real mode paces itself per-listing (driver.waitRandom, 4-10s) inside
// runCollection - TEST_RUN skips that entirely (no live Facebook calls at
// all), so --cycle needs its own pacing here or it would spin logging as
// fast as the loop can run.
const TEST_RUN_LOOP_DELAY_MS = 5000

// Confirmed live 2026-09-03: once the underlying Playwright page crashes
// ("Page crashed" - the browser tab itself died, not a normal navigation
// error), driver.gotoSearch throws instantly on every subsequent keyword
// forever, since nothing ever recreated the page. With the per-keyword catch
// below swallowing each failure and moving on immediately, that turned into
// a zero-delay infinite loop - 14 keywords x every lap x no backoff - that
// produced a 16GB collector.log (and, downstream, crash-looped the whole
// refresh-server process every time it tried to tail that file). A crashed
// page gets a fresh browser instead of being retried as-is, every failure
// backs off before the next attempt, and too many in a row stops the worker
// outright rather than spinning on a problem that isn't transient (dead
// proxy, FB blocking the IP, etc).
const MAX_CONSECUTIVE_FAILURES = 5
const FAILURE_BACKOFF_MS = 5000
const MAX_FAILURE_BACKOFF_MS = 60000

const SETTING_KEYS = [
  'collect.max_items_default',
  'collect.soft_wall_timeout_ms',
  'collect.pacing_min_ms',
  'collect.pacing_max_ms',
  'collect.loop_delay_ms',
  'collect.re_keywords_enabled',
  'collect.re_every_n_laps',
  'collect.re_max_items',
]

export interface CollectLapsDeps {
  db: DbClient
  logger: Logger
  delay: DelayFn
  browserLock: { acquire: () => Promise<void>; release: () => void }
  openBrowser: () => Promise<BrowserDriver>
  // One keyword's collection run (runCollection), with this lap's settings.
  collectQuery: (driver: PageDriver, query: LapQuery, settings: Record<string, number>) => Promise<void>
}

export interface CollectLapsOptions {
  cycle: boolean
  testRun: boolean
  explicitQuery?: string
  explicitMaxItems?: number
}

// Returns after one lap without --cycle, or once too many keywords fail in a row.
export async function runCollectLaps(deps: CollectLapsDeps, options: CollectLapsOptions): Promise<void> {
  const { db, logger, delay } = deps
  const { cycle } = options
  if (cycle) {
    logger.info('--cycle: looping indefinitely — Ctrl+C to stop')
  }

  let lap = 1
  let consecutiveFailures = 0
  do {
    const settings = await loadSettings(db, SETTING_KEYS)
    const maxItems = options.explicitMaxItems ?? settings['collect.max_items_default']
    const queries: LapQuery[] =
      options.explicitQuery !== undefined
        ? [{ query: options.explicitQuery, maxItems }]
        : planLapQueries({
            general: await loadCollectKeywords(db),
            // Only queried when the flag is on, so flag-off laps do no extra DB work.
            realEstate: settings['collect.re_keywords_enabled'] >= 1 ? await loadRealEstateKeywords(db) : [],
            lap,
            reEnabled: settings['collect.re_keywords_enabled'],
            reEveryNLaps: settings['collect.re_every_n_laps'],
            reMaxItems: settings['collect.re_max_items'],
            defaultMaxItems: maxItems,
          })
    if (cycle) logger.info(`--cycle: lap ${lap} starting, ${queries.length} motivated-seller keywords`)

    if (options.testRun) {
      for (const { query } of queries) {
        logger.info(`TEST_RUN: marketplace will call Facebook Marketplace to collect for query "${query}"`)
      }
    } else {
      const failures = await collectInBrowser(deps, queries, settings, consecutiveFailures)
      if (failures === null) return
      consecutiveFailures = failures
    }

    if (cycle) {
      if (options.testRun) {
        await delay(TEST_RUN_LOOP_DELAY_MS)
      } else {
        logger.info(
          `--cycle: lap ${lap} complete, sleeping ${settings['collect.loop_delay_ms']}ms with the browser closed`,
        )
        await delay(settings['collect.loop_delay_ms'])
      }
    }
    lap++
  } while (cycle)
}

// One lap's browser session. Returns the running consecutive-failure count, or
// null once it reaches MAX_CONSECUTIVE_FAILURES and the worker should stop.
async function collectInBrowser(
  { logger, delay, browserLock, openBrowser, collectQuery }: CollectLapsDeps,
  queries: LapQuery[],
  settings: Record<string, number>,
  failuresSoFar: number,
): Promise<number | null> {
  let consecutiveFailures = failuresSoFar
  // Browser (and the cross-process lock guarding it) only lives for
  // this one lap - check-listings shares the same lock and the VPS
  // can't run both Chromiums at once without swapping hard (see
  // browserLock.ts). Closing here, not just at process exit, is also
  // what actually lowers collect's request cadence: the pause between laps
  // (collect.loop_delay_ms) now happens with no browser open at all,
  // not just a paused-but-still-resident one.
  await browserLock.acquire()
  try {
    let browser = await openBrowser()
    try {
      for (const lapQuery of queries) {
        // One keyword's transient error (network blip, FB rate limit, a
        // DB write failure) used to propagate all the way up through
        // main()'s catch and kill the whole --cycle process - confirmed
        // live 2026-09-01: a single query failure ended a run meant to
        // loop keywords forever. Isolate per-keyword so --cycle
        // actually survives one bad query and moves on to the next.
        try {
          await collectQuery(browser.driver, lapQuery, settings)
          consecutiveFailures = 0
        } catch (err) {
          consecutiveFailures += 1
          logger.error(
            `query "${lapQuery.query}" failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} consecutive), skipping to next keyword: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
          )
          if (isBrowserUnusableError(err)) {
            logger.warn('browser is unusable, relaunching before continuing')
            try {
              await browser.close()
            } catch (closeErr) {
              logger.warn(
                `error closing crashed browser, continuing anyway: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
              )
            }
            browser = await openBrowser()
          }
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            logger.error(
              `${consecutiveFailures} consecutive keyword failures, stopping — this looks like a persistent problem (dead proxy, FB blocking this IP, etc), not a transient blip`,
            )
            return null
          }
          await delay(Math.min(FAILURE_BACKOFF_MS * consecutiveFailures, MAX_FAILURE_BACKOFF_MS))
        }
      }
    } finally {
      await browser.close()
    }
  } finally {
    browserLock.release()
  }
  return consecutiveFailures
}
