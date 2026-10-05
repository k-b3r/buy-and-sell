import { fileURLToPath } from 'node:url'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/env'
import { excludeIneligibleCategories } from '../../modules/pricing'
import { createLogger } from '../../platform/logger'
import { secretsFromEnv } from '../../platform/redact'

// Applies the pricing module's curated price-ineligible list. Rerun after
// editing that list (src/modules/pricing/ineligible-categories.ts).
async function main() {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env')

  const logger = createLogger('data/flag-price-ineligible.log', secretsFromEnv(process.env))
  const pool = createDbPool(dbUrl)
  try {
    await excludeIneligibleCategories(pool, logger)
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
