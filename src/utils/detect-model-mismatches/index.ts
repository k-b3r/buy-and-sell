import { fileURLToPath } from 'node:url'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/env'
import { createLogger } from '../../platform/logger'
import { findModelCodeMismatches } from '../../domains/marketplace'

interface CandidateRow {
  listing_id: string
  title: string
  product_id: number
  base_model: string
  variant_tier: string | null
}

async function getMatchedListings(db: DbClient): Promise<CandidateRow[]> {
  const result = (await db.query(
    `SELECT l.id AS listing_id, l.title, p.id AS product_id, p.base_model, p.variant_tier
     FROM listings l
     JOIN products p ON p.id = l.product_id
     WHERE l.title IS NOT NULL`,
    [],
  )) as { rows: CandidateRow[] }
  return result.rows
}

// Read-only by design, same as detect-generic-products - a full catalog scan
// is broad/heuristic enough (see model-mismatch.ts) that it belongs in front
// of a human before any row gets reassigned, not applied live. Each flagged
// row here is a candidate for the same manual fix already done once for
// listing 1000000000000002, not an auto-fix target.
async function main(): Promise<void> {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env')

  const logger = createLogger('data/detect-model-mismatches.log')
  const pool = createDbPool(dbUrl)
  try {
    const rows = await getMatchedListings(pool)
    let candidates = 0

    for (const row of rows) {
      const productText = `${row.base_model} ${row.variant_tier ?? ''}`.trim()
      const mismatches = findModelCodeMismatches(row.title, productText)
      if (mismatches.length === 0) continue

      candidates++
      logger.info(
        `listing ${row.listing_id} "${row.title}" -> product ${row.product_id} "${productText}" | ` +
          mismatches
            .map((m) => `${m.prefix}: title=${m.titleNumbers.join(',')} product=${m.productNumbers.join(',')}`)
            .join('; '),
      )
    }

    logger.info(`${candidates} candidate(s) found out of ${rows.length} product-matched listings`)
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
