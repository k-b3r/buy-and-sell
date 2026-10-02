import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { PageDriver } from '../../domains/marketplace'
import { launchBrowser, createBrowserDriver } from '../../domains/marketplace'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile, realDelay, isTestRun, writePidFile } from '../../platform/utils'
import { acquireBrowserLock, releaseBrowserLock, BROWSER_LOCK_PATH } from '../../platform/browserLock'
import { resolveProxy } from '../../domains/marketplace'
import type { CheckListingsCandidate } from '../../domains/marketplace/storage/listings'
import {
  getCheckListingsCandidates,
  markListingAlive,
  markListingSold,
  flagListingRemoved,
  deleteListing,
  refreshListingFields,
} from '../../domains/marketplace/storage/listings'
import type { ImageStore } from '../../platform/images'
import { createR2ImageStore, deleteListingPhotos } from '../../platform/images'
import { extractDetailFields } from '../../domains/marketplace'
import { resolvePageState } from '../../run'
import { loadSettings } from '../../platform/settings'

export type CheckOneListingResult =
  { status: 'sold' } | { status: 'alive' } | { status: 'flagged' } | { status: 'removed' } | { status: 'hard-block' }

// Single-listing core, decoupled from the batch loop below so it can also be
// driven on-demand (see refresh-server.ts) rather than only via the
// scheduled getCheckListingsCandidates backlog. Assumes the driver has
// ALREADY navigated to this listing — pacing (waitRandom) and navigation
// (openListing) stay caller-side, since a batch run and a single on-demand
// refresh want different pacing behavior around them (the batch loop's
// human-paced delay between listings has no reason to apply to a single
// user-triggered request).
export async function checkOneListing(
  driver: PageDriver,
  db: DbClient,
  imageStore: ImageStore,
  logger: Logger,
  candidate: CheckListingsCandidate,
  softWallTimeoutMs = 5000,
): Promise<CheckOneListingResult> {
  const result = await resolvePageState(
    driver,
    logger,
    () => driver.getDetailHtml(),
    softWallTimeoutMs,
    (html) => Object.keys(extractDetailFields(html)).length > 0,
  )

  if (result.status === 'stop') {
    if (result.reason !== 'soft-wall-persisted') {
      // Hard-block or unrecognized state — real signal of an actual
      // problem (not "removed"), fail closed same as everywhere else.
      logger.error(`stopping check-listings at listing ${candidate.id}`)
      return { status: 'hard-block' }
    }

    if (candidate.flagged_removed_at) {
      logger.info(
        `listing ${candidate.id} still soft-walled (flagged since ${candidate.flagged_removed_at}) — confirmed removed, deleting`,
      )
      await deleteListingPhotos(imageStore, logger, candidate.id)
      await deleteListing(db, candidate.id)
      return { status: 'removed' }
    }

    logger.warn(`listing ${candidate.id} soft-walled, flagging for confirmation on a later run`)
    await flagListingRemoved(db, candidate.id)
    return { status: 'flagged' }
  }

  const detailFields = extractDetailFields(result.html)

  if (detailFields.is_sold === true) {
    logger.info(`listing ${candidate.id} detected as sold`)
    await markListingSold(db, candidate.id)
    return { status: 'sold' }
  }

  if (candidate.flagged_removed_at) {
    logger.info(`listing ${candidate.id} recovered — was flagged, now accessible again, clearing flag`)
  }
  // Still live — sync title/price/description/condition in case the
  // seller edited them since we first saw this listing, and re-sync photos
  // too if Facebook's own photo ids show the seller actually swapped them
  // (see refreshListingFields).
  await refreshListingFields(db, imageStore, logger, candidate.source_photo_ids, detailFields)
  await markListingAlive(db, candidate.id)
  return { status: 'alive' }
}

// Postgres-only, same as every other script now (see CONTEXT.md on removing
// the local JSONL file that used to double as a second source of truth) —
// safe to run at the same time as `collect`, ordinary row-level upserts/deletes.
export async function runCheckListings(
  driver: PageDriver,
  db: DbClient,
  imageStore: ImageStore,
  logger: Logger,
  candidates: CheckListingsCandidate[],
  softWallTimeoutMs = 5000,
  pacingMinMs = 2000,
  pacingMaxMs = 4000,
): Promise<void> {
  logger.info(`${candidates.length} listings to check`)

  for (const candidate of candidates) {
    await driver.waitRandom(pacingMinMs, pacingMaxMs)
    logger.info(`checking listing ${candidate.id}`)
    await driver.openListing({ id: candidate.id })

    const result = await checkOneListing(driver, db, imageStore, logger, candidate, softWallTimeoutMs)
    if (result.status === 'hard-block') return
  }
}

async function main() {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — check-listings requires Postgres')

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL } = process.env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_BASE_URL) {
    throw new Error('R2 not fully configured in .env — check-listings needs to be able to delete photos')
  }

  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const limitArg = args[0]
  let explicitLimit: number | undefined
  if (limitArg !== undefined) {
    const parsed = Number(limitArg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid limit argument: "${limitArg}"`)
    }
    explicitLimit = parsed
  }

  const logger = createLogger('data/check-listings.log')
  writePidFile('data/check-listings.pid')
  const pool = createDbPool(dbUrl)
  const imageStore = createR2ImageStore({
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_KEY,
    bucket: R2_BUCKET_NAME,
    publicBaseUrl: R2_PUBLIC_BASE_URL,
  })

  // Opt-in, same as collect: no WEBSHARE_PROXY/SOCKS_PROXY at all means a
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

  logger.info('looping indefinitely — Ctrl+C to stop')
  try {
    let lap = 1
    for (;;) {
      logger.info(`lap ${lap} starting`)
      const settings = await loadSettings(pool, [
        'check_listings.loop_delay_ms',
        'check_listings.limit_default',
        'check_listings.soft_wall_timeout_ms',
        'check_listings.pacing_min_ms',
        'check_listings.pacing_max_ms',
        'check_listings.re_recheck_min_days',
      ])
      const limit = explicitLimit ?? settings['check_listings.limit_default']
      const candidates = await getCheckListingsCandidates(pool, limit, settings['check_listings.re_recheck_min_days'])
      if (isTestRun()) {
        logger.info(`TEST_RUN: marketplace will call Facebook to check ${candidates.length} listings`)
      } else if (candidates.length > 0) {
        // Browser only exists for the lifetime of this lap's batch, not the
        // whole process - collect (the only other browser-launching worker)
        // shares this same lock, and the VPS can't run both Chromiums at
        // once without swapping hard (see browserLock.ts). Skipped entirely
        // when there's nothing to check, same effect a min-batch gate would
        // have had, for free.
        await acquireBrowserLock(BROWSER_LOCK_PATH, logger)
        try {
          const { page, close } = await launchBrowser({ proxy })
          const driver = createBrowserDriver(page)
          try {
            await runCheckListings(
              driver,
              pool,
              imageStore,
              logger,
              candidates,
              settings['check_listings.soft_wall_timeout_ms'],
              settings['check_listings.pacing_min_ms'],
              settings['check_listings.pacing_max_ms'],
            )
          } finally {
            await close()
          }
        } finally {
          releaseBrowserLock(BROWSER_LOCK_PATH)
        }
      } else {
        logger.info('lap has no candidates, skipping browser launch')
      }
      logger.info(`lap ${lap} complete, sleeping ${settings['check_listings.loop_delay_ms']}ms`)
      lap++
      await realDelay(settings['check_listings.loop_delay_ms'])
    }
  } finally {
    await pool.end()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
