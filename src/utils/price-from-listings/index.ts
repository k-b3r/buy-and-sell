import { fileURLToPath } from 'node:url'
import { createLogger } from '../../platform/logger'
import { secretsFromEnv } from '../../platform/redact'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/env'
import { getListingPricesByProduct, runPriceFromListings } from '../../modules/pricing'

async function main() {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — price-from-listings requires Postgres')

  const logger = createLogger('data/price-from-listings.log', secretsFromEnv(process.env))
  const pool = createDbPool(dbUrl)

  try {
    const groups = await getListingPricesByProduct(pool)
    logger.info(`${groups.length} product/condition groups with 2+ listings to compute a price range for`)
    await runPriceFromListings(pool, logger, groups)
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
