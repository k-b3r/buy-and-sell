import { fileURLToPath } from 'node:url'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/utils'
import { mergeDuplicateProduct } from '../../domains/marketplace/storage/products'
import { normalizeBaseModel, CANONICAL_BASE_MODEL } from '../../domains/marketplace'
import { mergeProductVariantAliases } from './variant-aliases'
import { PRODUCT_VARIANT_ALIAS_RULES } from './variant-alias-rules'

interface ProductRow {
  id: number
  variant_tier: string | null
}

// Renames in place when nothing collides. When the canonical name + same raw
// variant_tier already exists as a different row (the common case — that's
// WHY these were split), merges into it instead of renaming, since the
// products_base_model_variant_idx unique index would otherwise reject the
// rename outright.
export async function mergeDuplicateProducts(
  db: DbClient,
  canonicalMap: Record<string, string> = CANONICAL_BASE_MODEL,
): Promise<{ renamed: number; merged: number }> {
  let renamed = 0
  let merged = 0

  for (const [alias, canonical] of Object.entries(canonicalMap)) {
    const aliasRows = (await db.query(`SELECT id, variant_tier FROM products WHERE base_model = $1`, [alias])) as {
      rows: ProductRow[]
    }

    for (const row of aliasRows.rows) {
      const existing = (await db.query(
        `SELECT id FROM products WHERE base_model = $1 AND COALESCE(variant_tier, '') = COALESCE($2, '') AND id != $3`,
        [canonical, row.variant_tier, row.id],
      )) as { rows: { id: number }[] }

      if (existing.rows.length > 0) {
        await mergeDuplicateProduct(db, existing.rows[0].id, row.id)
        merged++
      } else {
        await db.query(`UPDATE products SET base_model = $1, base_model_normalized = $2 WHERE id = $3`, [
          canonical,
          normalizeBaseModel(canonical),
          row.id,
        ])
        renamed++
      }
    }
  }

  return { renamed, merged }
}

async function main() {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env')
  const dryRun = process.argv.includes('--dry-run')

  const pool = createDbPool(dbUrl)
  try {
    if (!dryRun) {
      const { renamed, merged } = await mergeDuplicateProducts(pool)
      console.log(`[base-model map] renamed ${renamed} products, merged ${merged} duplicate rows`)
    }

    const variantResult = await mergeProductVariantAliases(pool, PRODUCT_VARIANT_ALIAS_RULES, { dryRun })
    console.log(
      `[variant-alias rules]${dryRun ? ' (dry run)' : ''} renamed ${variantResult.renamed} products, merged ${variantResult.merged} duplicate rows`,
    )
    if (variantResult.noMatch.length > 0) {
      console.log(`${variantResult.noMatch.length} rule(s) matched nothing live (already applied, or a transcription mismatch):`)
      for (const rule of variantResult.noMatch) {
        console.log(`  ${rule.aliasBase} [${rule.aliasVariant ?? ''}] -> ${rule.canonicalBase} [${rule.canonicalVariant ?? ''}]`)
      }
    }
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
