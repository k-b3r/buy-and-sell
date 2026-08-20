import { existsSync } from 'node:fs'
import { launchBrowser, createBrowserDriver } from './browser'
import { createLogger } from './logger'
import { createDbPool, upsertListing } from './db'
import { createR2ImageStore, storeListingPhotos } from './images'
import { extractDetailFields } from './extract/detail'
import { resolvePageState } from './run'
import { loadListings, saveListings } from './jsonl'

const OUTPUT_PATH = 'data/listings.jsonl'

// One-off backfill for listings collected before the listing_photos extraction
// fix and R2 image storage existed. Re-visits each listing live (paced like a
// normal collection run) to pick up the full photo carousel now that it can
// actually be extracted, and re-hosts it to R2. Resumable: progress is written
// after every listing, and already-backfilled listings (stored_photo_urls
// already set) are skipped on the next run.
async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }

  const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--')
  const headed = rawArgs.includes('--headed')
  const args = rawArgs.filter((arg) => arg !== '--headed')

  const limitArg = args[0]
  let limit: number | undefined
  if (limitArg !== undefined) {
    const parsed = Number(limitArg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid limit argument: "${limitArg}"`)
    }
    limit = parsed
  }

  const logger = createLogger('data/backfill.log')

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL } = process.env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_BASE_URL) {
    logger.error('R2 not fully configured (.env), aborting backfill')
    return
  }
  const imageStore = createR2ImageStore({
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_KEY,
    bucket: R2_BUCKET_NAME,
    publicBaseUrl: R2_PUBLIC_BASE_URL,
  })

  const dbUrl = process.env.DATABASE_URL
  const pool = dbUrl ? createDbPool(dbUrl) : undefined
  if (pool) {
    logger.info('database configured, backfilled listings will be upserted to Postgres')
  } else {
    logger.warn('no DATABASE_URL set, skipping database writes (JSONL only)')
  }

  const listings = loadListings(OUTPUT_PATH)
  const pending = listings.filter((l) => !l.stored_photo_urls)
  const todo = limit !== undefined ? pending.slice(0, limit) : pending
  logger.info(
    `${listings.length} total listings, ${pending.length} pending photo backfill, processing ${todo.length} this run`,
  )

  const { page, close } = await launchBrowser({ headless: !headed })
  const driver = createBrowserDriver(page)

  // A soft-wall that persists after refresh looks identical, from the HTML
  // alone, whether it's a real session-wide block or just one specific
  // listing that's been removed/sold and redirects anonymous visitors to
  // login. Empirically (6/6 confirmed by hand across two runs) a persisted
  // soft-wall on a detail page means the listing is gone, not a real
  // session-wide block, and dead listings legitimately cluster consecutively
  // (adjacent rows = same original collection batch = plausibly expired
  // together) — so a run of consecutive soft-walls is no longer treated as
  // evidence of a real block. Always skip and keep going; mark skipped
  // listings so they can be spot-checked/validated in a later separate pass.
  // Hard-block still fails closed immediately below — unaffected.
  let softWallSkipCount = 0

  try {
    for (const listing of todo) {
      const id = String(listing.id)
      await driver.waitRandom(4000, 10000)
      logger.info(`opening listing ${id}`)
      await driver.openListing({ id })

      const result = await resolvePageState(
        driver,
        logger,
        () => driver.getDetailHtml(),
        5000,
        (html) => Object.keys(extractDetailFields(html)).length > 0,
      )
      if (result.status === 'stop') {
        if (result.reason === 'soft-wall-persisted') {
          softWallSkipCount += 1
          logger.warn(
            `soft-wall persisted for listing ${id} (likely removed/unavailable), marking as no-photos-available ` +
              `and skipping (${softWallSkipCount} skipped so far this run)`,
          )
          // Reversible: delete the empty array and rerun if a listing is
          // later confirmed (via a validation pass) to still be live.
          const idx = listings.findIndex((l) => String(l.id) === id)
          if (idx !== -1) listings[idx] = { ...listing, stored_photo_urls: [] }
          saveListings(OUTPUT_PATH, listings)
          continue
        }
        logger.error(`stopping backfill at listing ${id}`)
        break
      }

      const detail = extractDetailFields(result.html)
      const photoUrls = await storeListingPhotos(imageStore, logger, id, detail.listing_photos)

      const merged = { ...listing, ...detail, stored_photo_urls: photoUrls }
      const idx = listings.findIndex((l) => String(l.id) === id)
      if (idx !== -1) listings[idx] = merged
      saveListings(OUTPUT_PATH, listings)

      if (pool) {
        await upsertListing(pool, merged)
      }

      logger.info(`saved ${photoUrls.length} photos for listing ${id}`)
    }
  } finally {
    if (!headed) await close()
    if (pool) await pool.end()
  }

  logger.info(`backfill complete (${softWallSkipCount} listings skipped as likely unavailable, marked for later validation)`)
  if (headed) {
    logger.info('--headed: leaving browser window open for inspection, Ctrl+C when done')
    await new Promise(() => {})
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
