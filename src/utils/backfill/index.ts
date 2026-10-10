import { fileURLToPath } from 'node:url'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/env'
import { launchBrowserDriver } from '../../modules/collection/browser'
import { createLogger } from '../../platform/logger'
import { secretsFromEnv } from '../../platform/redact'
import {
  backfillListingPhotos,
  createListingPhotos,
  getBackfillCandidates,
  requireBackfillProxy,
} from '../../modules/collection'
import { r2PhotoIoFromEnv } from '../../platform/r2-photos'
import { realDelay } from '../../platform/delay'
import { parseLimit, readLimitArg } from '../../platform/limit-arg'

// One-off backfill for listings collected before the listing_photos extraction
// fix and R2 image storage existed. Re-visits each listing live (paced like a
// normal collection run) to pick up the full photo carousel now that it can
// actually be extracted, and re-hosts it to R2. Resumable: Postgres is the
// only source of truth (see CONTEXT.md on removing JSONL) — a listing's
// stored_photo_urls being non-null on the row itself is what marks it done.
async function main() {
  loadEnvFile()

  const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--')
  const headed = rawArgs.includes('--headed')
  const args = rawArgs.filter((arg) => arg !== '--headed')

  const limitArg = readLimitArg(args)
  let limit: number | undefined
  if (limitArg !== undefined) {
    const parsed = parseLimit(limitArg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid limit argument: "${limitArg}"`)
    }
    limit = parsed
  }

  const logger = createLogger('data/backfill.log', secretsFromEnv(process.env))

  const proxy = await requireBackfillProxy(process.env)
  logger.info(`egress confirmed via ${proxy.source} (${proxy.server})`)

  const photoIo = r2PhotoIoFromEnv(process.env)
  if (!photoIo) {
    logger.error('R2 not fully configured (.env), aborting backfill')
    return
  }
  const photos = createListingPhotos({ ...photoIo, logger })

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — backfill requires Postgres')
  const pool = createDbPool(dbUrl)

  const pending = await getBackfillCandidates(pool)
  const todo = limit !== undefined ? pending.slice(0, limit) : pending
  logger.info(`${pending.length} pending photo backfill, processing ${todo.length} this run`)

  const { driver, close } = await launchBrowserDriver(proxy, { headless: !headed })

  const softWallSkipCount = await backfillListingPhotos(
    { driver, db: pool, photos, logger, delay: realDelay },
    todo,
  ).finally(async () => {
    if (!headed) await close()
    await pool.end()
  })

  logger.info(
    `backfill complete (${softWallSkipCount} listings skipped as likely unavailable, marked for later validation)`,
  )
  if (headed) {
    logger.info('--headed: leaving browser window open for inspection, Ctrl+C when done')
    await new Promise(() => {})
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
