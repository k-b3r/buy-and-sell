import { fileURLToPath } from 'node:url'
import { createLogger } from '../../platform/logger'
import { secretsFromEnv } from '../../platform/redact'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/env'
import { createR2ImageStore } from '../../platform/images'
import { getFarListingCandidates, purgeFarListings } from '../../modules/collection'

async function main() {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — purge-far-listings requires Postgres')

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL } = process.env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_BASE_URL) {
    throw new Error('R2 env vars not set — purge-far-listings must also delete photos, refusing to run without it')
  }
  const imageStore = createR2ImageStore({
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_KEY,
    bucket: R2_BUCKET_NAME,
    publicBaseUrl: R2_PUBLIC_BASE_URL,
  })

  const logger = createLogger('data/purge-far-listings.log', secretsFromEnv(process.env))
  const pool = createDbPool(dbUrl)

  try {
    const candidates = await getFarListingCandidates(pool)
    logger.info(`${candidates.length} listings found outside the 80km Manila service area`)
    await purgeFarListings(pool, logger, imageStore, candidates)
  } finally {
    await pool.end()
  }
  logger.info('purge-far-listings complete')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
