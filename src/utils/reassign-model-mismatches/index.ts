import { fileURLToPath } from 'node:url'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/env'
import { createLogger } from '../../platform/logger'
import { secretsFromEnv } from '../../platform/redact'
import { normalizeBaseModel } from '../../modules/catalog'
import { findModelCodeMismatches, deriveTargetBaseModel } from '../../modules/catalog'
import { updateListingProductIds } from '../../modules/catalog'

interface CandidateRow {
  listing_id: string
  title: string
  product_id: number
  base_model: string
  variant_tier: string | null
  variant_tier_normalized: string | null
}

async function getMatchedListings(db: DbClient): Promise<CandidateRow[]> {
  const result = (await db.query(
    `SELECT l.id AS listing_id, l.title, p.id AS product_id, p.base_model, p.variant_tier, p.variant_tier_normalized
     FROM listings l
     JOIN products p ON p.id = l.product_id
     WHERE l.title IS NOT NULL`,
    [],
  )) as { rows: CandidateRow[] }
  return result.rows
}

async function findExistingProductId(
  db: DbClient,
  baseModel: string,
  variantTierNormalized: string | null,
): Promise<number | null> {
  const result = (await db.query(
    `SELECT id FROM products WHERE base_model_normalized = $1 AND variant_tier_normalized IS NOT DISTINCT FROM $2`,
    [normalizeBaseModel(baseModel), variantTierNormalized],
  )) as { rows: { id: number }[] }
  return result.rows[0]?.id ?? null
}

// Same fix pattern already applied by hand once
// (listing 1000000000000002, S23 mis-grouped under an S26 product): reassign
// listings.product_id to the product whose name actually matches the
// title's model number, instead of the one detect-model-mismatches.ts
// flagged them under. Deliberately narrow — only acts when
// deriveTargetBaseModel resolves unambiguously AND that exact product
// already exists in the catalog; anything else is logged as skipped for a
// human to resolve rather than guessed at or auto-created.
export async function reassignModelMismatches(
  db: DbClient,
  dryRun: boolean,
): Promise<{ reassigned: number; skipped: number }> {
  const rows = await getMatchedListings(db)
  let reassigned = 0
  let skipped = 0
  const assignments: { id: string; productId: number }[] = []

  for (const row of rows) {
    const productText = `${row.base_model} ${row.variant_tier ?? ''}`.trim()
    const mismatches = findModelCodeMismatches(row.title, productText)
    if (mismatches.length !== 1) {
      if (mismatches.length > 1) skipped++
      continue
    }

    const targetBaseModel = deriveTargetBaseModel(row.base_model, mismatches[0])
    if (targetBaseModel === null) {
      console.log(`skip listing ${row.listing_id}: ambiguous mismatch, can't derive a single target base_model`)
      skipped++
      continue
    }

    const targetProductId = await findExistingProductId(db, targetBaseModel, row.variant_tier_normalized)
    if (targetProductId === null) {
      console.log(
        `skip listing ${row.listing_id}: derived target "${targetBaseModel}" has no existing matching product`,
      )
      skipped++
      continue
    }
    if (targetProductId === row.product_id) {
      skipped++
      continue
    }

    console.log(
      `${dryRun ? '[dry run] would reassign' : 'reassigning'} listing ${row.listing_id} "${row.title}": product ${row.product_id} "${row.base_model}" -> product ${targetProductId} "${targetBaseModel}"`,
    )
    assignments.push({ id: row.listing_id, productId: targetProductId })
    reassigned++
  }

  if (!dryRun && assignments.length > 0) await updateListingProductIds(db, assignments)

  return { reassigned, skipped }
}

async function main(): Promise<void> {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env')
  const dryRun = process.argv.includes('--dry-run')

  const logger = createLogger('data/reassign-model-mismatches.log', secretsFromEnv(process.env))
  const pool = createDbPool(dbUrl)
  try {
    const { reassigned, skipped } = await reassignModelMismatches(pool, dryRun)
    logger.info(
      `${dryRun ? '[dry run] ' : ''}${reassigned} listing(s) reassigned, ${skipped} skipped (ambiguous or no matching product)`,
    )
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
