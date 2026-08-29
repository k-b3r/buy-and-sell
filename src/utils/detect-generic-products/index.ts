import { fileURLToPath } from 'node:url'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/utils'
import { createLogger } from '../../platform/logger'
import type { GenericReason } from '../../domains/marketplace'
import { detectGenericBaseModel } from '../../domains/marketplace'

interface BaseModelRow {
  base_model: string
}

async function getUnflaggedBaseModels(db: DbClient): Promise<string[]> {
  const result = (await db.query(
    `SELECT DISTINCT base_model FROM products WHERE NOT price_lookup_excluded ORDER BY base_model`,
    [],
  )) as { rows: BaseModelRow[] }
  return result.rows.map((r) => r.base_model)
}

// Read-only by design - reports candidates for a human (or an agent) to
// review before adding them to flag-price-ineligible/index.ts's curated
// PRICE_INELIGIBLE_CATEGORIES list, same as every entry already in that file
// was found. Detection and application are deliberately separate steps here
// (unlike detectGenericBaseModel's other caller, the price-lookup workers,
// which DO apply it live - a live miss there just costs one skipped
// lookup, reversible, whereas this script's job is a broader/riskier sweep
// meant for human review before being folded into the curated list).
async function main(): Promise<void> {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env')

  const logger = createLogger('data/detect-generic-products.log')
  const pool = createDbPool(dbUrl)
  try {
    const baseModels = await getUnflaggedBaseModels(pool)
    const byReason: Record<GenericReason, string[]> = {
      real_estate: [],
      too_generic: [],
      parts_accessory: [],
      service: [],
    }
    for (const baseModel of baseModels) {
      const result = detectGenericBaseModel(baseModel)
      if (result) byReason[result.reason].push(baseModel)
    }

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
