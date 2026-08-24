import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger } from './logger'
import { createLogger } from './logger'
import type { PageDriver } from './driver'
import { launchBrowser, createBrowserDriver } from './browser'
import type { DbClient, CheckListingsCandidate } from './db'
import {
  createDbPool,
  getCheckListingsCandidates,
  markListingAlive,
  markListingSold,
  flagListingRemoved,
  deleteListing,
  refreshListingFields,
} from './db'
import type { ImageStore } from './images'
import { createR2ImageStore, deleteListingPhotos } from './images'
import { extractDetailFields } from './extract/detail'
import { resolvePageState } from './run'

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
): Promise<void> {
  logger.info(`${candidates.length} listings to check`)

  for (const candidate of candidates) {
    await driver.waitRandom(4000, 10000)
    logger.info(`checking listing ${candidate.id}`)
    await driver.openListing({ id: candidate.id })

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
        return
      }

      if (candidate.flagged_removed_at) {
        logger.info(
          `listing ${candidate.id} still soft-walled (flagged since ${candidate.flagged_removed_at}) — confirmed removed, deleting`,
        )
        await deleteListingPhotos(imageStore, logger, candidate.id)
        await deleteListing(db, candidate.id)
      } else {
        logger.warn(`listing ${candidate.id} soft-walled, flagging for confirmation on a later run`)
        await flagListingRemoved(db, candidate.id)
      }
      continue
    }

    const detailFields = extractDetailFields(result.html)

    if (detailFields.is_sold === true) {
      logger.info(`listing ${candidate.id} detected as sold`)
      await markListingSold(db, candidate.id)
      continue
    }

    if (candidate.flagged_removed_at) {
      logger.info(`listing ${candidate.id} recovered — was flagged, now accessible again, clearing flag`)
    }
    // Still live — sync title/price/description/condition in case the
    // seller edited them since we first saw this listing (see
    // refreshListingFields; photos are deliberately left untouched).
    await refreshListingFields(db, detailFields)
    await markListingAlive(db, candidate.id)
  }
}

async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — check-listings requires Postgres')

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL } = process.env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_BASE_URL) {
    throw new Error('R2 not fully configured in .env — check-listings needs to be able to delete photos')
  }

  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const limitArg = args[0]
  const limit = limitArg !== undefined ? Number(limitArg) : 100
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
    throw new Error(`invalid limit argument: "${limitArg}"`)
  }

  const logger = createLogger('data/check-listings.log')
  const pool = createDbPool(dbUrl)
  const imageStore = createR2ImageStore({
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_KEY,
    bucket: R2_BUCKET_NAME,
    publicBaseUrl: R2_PUBLIC_BASE_URL,
  })

  const socksProxy = process.env.SOCKS_PROXY
  const { page, close } = await launchBrowser({ socksProxy })
  const driver = createBrowserDriver(page)

  try {
    const candidates = await getCheckListingsCandidates(pool, limit)
    await runCheckListings(driver, pool, imageStore, logger, candidates)
  } finally {
    await close()
    await pool.end()
  }
  logger.info('check-listings complete')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
