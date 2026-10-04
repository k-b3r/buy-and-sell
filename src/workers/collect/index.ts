import { launchBrowser, createBrowserDriver } from '../../domains/marketplace/browser'
import { runCollection } from '../../run'
import { createLogger } from '../../platform/logger'
import { autoApprove } from '../../platform/review'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile, isTestRun } from '../../platform/env'
import { realDelay } from '../../platform/delay'
import { writePidFile } from '../../platform/utils'
import { acquireBrowserLock, releaseBrowserLock, BROWSER_LOCK_PATH } from '../../platform/browserLock'
import { createR2ImageStore } from '../../platform/images'
import { resolveProxy } from '../../domains/marketplace'
import { loadSettings } from '../../platform/settings'
import { loadCollectKeywords, loadRealEstateKeywords, planLapQueries } from '../../platform/collect-keywords'
import type { LapQuery } from '../../platform/collect-keywords'

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

// "Page crashed" is the browser tab itself dying; "Target page, context or
// browser has been closed" is Playwright's error when the browser/context
// handle is gone entirely - confirmed live 2026-09-03 via
// buy-and-sell-server.service's KillMode=control-group SIGTERMing a
// still-running collect worker's browser as collateral damage from an
// unrelated server restart. Both leave the existing driver permanently
// unusable, so both need a fresh browser, not just a retry.
const BROWSER_UNUSABLE_ERROR_SUBSTRINGS = ['Page crashed', 'Target page, context or browser has been closed']

function isBrowserUnusableError(err: unknown): boolean {
  return err instanceof Error && BROWSER_UNUSABLE_ERROR_SUBSTRINGS.some((s) => err.message.includes(s))
}

async function main() {
  loadEnvFile()
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const cycle = args.includes('--cycle')
  const rest = args.filter((arg) => arg !== '--cycle')
  // No explicit query and not --cycle (the dashboard's Start button, and a
  // bare `pnpm run collect`) used to fall back to a single hardcoded
  // "headphones" test query - now runs one pass through the full
  // motivated-seller keyword list instead (loaded fresh each lap below, see
  // loadCollectKeywords), same list --cycle loops forever through. An
  // explicit single query (e.g. `pnpm run collect -- "gaming chair"`)
  // still overrides it exactly as before.
  const explicitQuery = !cycle ? rest[0] : undefined
  const maxItemsArg = rest[cycle ? 0 : 1]
  // run.ts's pagination loop treats an unset maxItems as "just the first
  // page" (its target defaults to whatever the first batch happened to
  // contain, not a real cap) - confirmed live 2026-08-28: every run.ts
  // caller here (manual `pnpm run collect` with no args, and the
  // dashboard's Start button, which spawns with zero args) hit exactly that
  // and silently never paginated past page 1. An explicit CLI arg always
  // wins; otherwise collect.max_items_default (loaded fresh each lap below)
  // gives every no-args run a real per-query target instead.
  let explicitMaxItems: number | undefined
  if (maxItemsArg !== undefined) {
    const parsed = Number(maxItemsArg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid maxItems argument: "${maxItemsArg}"`)
    }
    explicitMaxItems = parsed
  }

  const daysSinceListedArg = rest[cycle ? 1 : 2]
  let daysSinceListed: number | undefined
  if (daysSinceListedArg !== undefined) {
    const parsed = Number(daysSinceListedArg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid daysSinceListed argument: "${daysSinceListedArg}"`)
    }
    daysSinceListed = parsed
  }

  const logger = createLogger('data/collector.log')
  writePidFile('data/collector.pid')

  // Opt-in, same as before: no WEBSHARE_PROXY/SOCKS_PROXY at all means a
  // local run already on a residential IP, no egress check needed. Either
  // one configured means it must actually work - fail closed rather than
  // silently launching direct.
  let proxy: Awaited<ReturnType<typeof resolveProxy>>['proxy']
  if (process.env.WEBSHARE_PROXY || process.env.SOCKS_PROXY) {
    const resolution = await resolveProxy(process.env)
    if (!resolution.ok) {
      logger.error(resolution.error!)
      process.exit(1)
    }
    proxy = resolution.proxy
    logger.info(`egress confirmed via ${proxy!.source} (${proxy!.server})`)
  }

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error("DATABASE_URL not set in .env — Postgres is the collector's only persistence now")
  const pool = createDbPool(dbUrl)

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL } = process.env
  const r2Configured = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_KEY && R2_BUCKET_NAME && R2_PUBLIC_BASE_URL
  const imageStore = r2Configured
    ? createR2ImageStore({
        accountId: R2_ACCOUNT_ID,
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_KEY,
        bucket: R2_BUCKET_NAME,
        publicBaseUrl: R2_PUBLIC_BASE_URL,
      })
    : undefined
  if (imageStore) {
    logger.info('R2 configured, photo carousels will be downloaded and re-hosted')
  } else {
    logger.warn('R2 not configured, skipping photo download (signed CDN URLs will expire)')
  }

  if (cycle) {
    logger.info('--cycle: looping indefinitely — Ctrl+C to stop')
  }

  try {
    let lap = 1
    let consecutiveFailures = 0
    do {
      const settings = await loadSettings(pool, [
        'collect.max_items_default',
        'collect.soft_wall_timeout_ms',
        'collect.pacing_min_ms',
        'collect.pacing_max_ms',
        'collect.loop_delay_ms',
        'collect.re_keywords_enabled',
        'collect.re_every_n_laps',
        'collect.re_max_items',
      ])
      const maxItems = explicitMaxItems ?? settings['collect.max_items_default']
      const queries: LapQuery[] =
        explicitQuery !== undefined
          ? [{ query: explicitQuery, maxItems }]
          : planLapQueries({
              general: await loadCollectKeywords(pool),
              // Only queried when the flag is on, so flag-off laps do no extra DB work.
              realEstate: settings['collect.re_keywords_enabled'] >= 1 ? await loadRealEstateKeywords(pool) : [],
              lap,
              reEnabled: settings['collect.re_keywords_enabled'],
              reEveryNLaps: settings['collect.re_every_n_laps'],
              reMaxItems: settings['collect.re_max_items'],
              defaultMaxItems: maxItems,
            })
      if (cycle) logger.info(`--cycle: lap ${lap} starting, ${queries.length} motivated-seller keywords`)

      if (isTestRun(process.env)) {
        for (const { query } of queries) {
          logger.info(`TEST_RUN: marketplace will call Facebook Marketplace to collect for query "${query}"`)
        }
      } else {
        // Browser (and the cross-process lock guarding it) only lives for
        // this one lap - check-listings shares the same lock and the VPS
        // can't run both Chromiums at once without swapping hard (see
        // browserLock.ts). Closing here, not just at process exit, is also
        // what actually lowers collect's request cadence: the pause below
        // (collect.loop_delay_ms) now happens with no browser open at all,
        // not just a paused-but-still-resident one.
        await acquireBrowserLock(BROWSER_LOCK_PATH, logger)
        try {
          let { page, close } = await launchBrowser({ proxy })
          let driver = createBrowserDriver(page)
          try {
            for (const { query, maxItems: queryMaxItems } of queries) {
              // One keyword's transient error (network blip, FB rate limit, a
              // DB write failure) used to propagate all the way up through
              // main()'s catch and kill the whole --cycle process - confirmed
              // live 2026-09-01: a single query failure ended a run meant to
              // loop keywords forever. Isolate per-keyword so --cycle
              // actually survives one bad query and moves on to the next.
              try {
                await runCollection(
                  driver,
                  logger,
                  autoApprove,
                  process.stdin,
                  process.stdout,
                  {
                    query,
                    softWallTimeoutMs: settings['collect.soft_wall_timeout_ms'],
                    pacingMinMs: settings['collect.pacing_min_ms'],
                    pacingMaxMs: settings['collect.pacing_max_ms'],
                    maxItems: queryMaxItems,
                    daysSinceListed,
                  },
                  pool,
                  imageStore,
                )
                consecutiveFailures = 0
              } catch (err) {
                consecutiveFailures += 1
                logger.error(
                  `query "${query}" failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} consecutive), skipping to next keyword: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
                )
                if (isBrowserUnusableError(err)) {
                  logger.warn('browser is unusable, relaunching before continuing')
                  try {
                    await close()
                  } catch (closeErr) {
                    logger.warn(
                      `error closing crashed browser, continuing anyway: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
                    )
                  }
                  const relaunch = await launchBrowser({ proxy })
                  page = relaunch.page
                  close = relaunch.close
                  driver = createBrowserDriver(page)
                }
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                  logger.error(
                    `${consecutiveFailures} consecutive keyword failures, stopping — this looks like a persistent problem (dead proxy, FB blocking this IP, etc), not a transient blip`,
                  )
                  return
                }
                await realDelay(Math.min(FAILURE_BACKOFF_MS * consecutiveFailures, MAX_FAILURE_BACKOFF_MS))
              }
            }
          } finally {
            await close()
          }
        } finally {
          releaseBrowserLock(BROWSER_LOCK_PATH)
        }
      }

      if (cycle) {
        if (isTestRun(process.env)) {
          await realDelay(TEST_RUN_LOOP_DELAY_MS)
        } else {
          logger.info(
            `--cycle: lap ${lap} complete, sleeping ${settings['collect.loop_delay_ms']}ms with the browser closed`,
          )
          await realDelay(settings['collect.loop_delay_ms'])
        }
      }
      lap++
    } while (cycle)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
