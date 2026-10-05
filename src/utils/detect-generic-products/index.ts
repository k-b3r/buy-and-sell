import { fileURLToPath } from 'node:url'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/env'
import { createLogger } from '../../platform/logger'
import { secretsFromEnv } from '../../platform/redact'
import type { GenericReason } from '../../modules/pricing'
import { getUnexcludedBaseModels, groupGenericBaseModels } from '../../modules/pricing'

// Read-only report for a human to review before curating the pricing
// module's ineligible-categories list (see groupGenericBaseModels).
async function main(): Promise<void> {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env')

  const logger = createLogger('data/detect-generic-products.log', secretsFromEnv(process.env))
  const pool = createDbPool(dbUrl)
  try {
    const baseModels = await getUnexcludedBaseModels(pool)
    const byReason = groupGenericBaseModels(baseModels)

    for (const reason of Object.keys(byReason) as GenericReason[]) {
      const matches = byReason[reason]
      logger.info(`${reason}: ${matches.length} candidates`)
      for (const bm of matches) logger.info(`  ${bm}`)
    }
    const total = Object.values(byReason).reduce((sum, arr) => sum + arr.length, 0)
    logger.info(`${total} candidates found out of ${baseModels.length} not-yet-excluded base_model values`)
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
