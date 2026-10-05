import type { DbClient } from '../../platform/storage'
import { findProductIdsByNormalizedName, mergeDuplicateProduct } from './product-storage'
import { CANONICAL_BASE_MODEL, normalizeBaseModel, normalizeVariantTier } from './products'

interface ProductRow {
  id: number
  variant_tier: string | null
}

// Retroactive fix for duplicates CANONICAL_BASE_MODEL now prevents at
// extraction time. Renames in place when nothing collides. When the
// canonical name + same raw variant_tier already exists as a different row
// (the common case — that's WHY these were split), merges into it instead
// of renaming, since the products_base_model_variant_idx unique index would
// otherwise reject the rename outright.
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

// Generalizes mergeDuplicateProducts (base_model-only rename) to also move
// text between base_model and variant_tier - most of the duplicate-product
// cases found in the 2026-09-02 catalog scan are exactly that (e.g.
// "iPhone 14 Plus" [] should be "iPhone 14" [Plus]), which the simpler tool
// can't express since it only ever rewrites base_model and assumes
// variant_tier already matches between alias and canonical.
export interface ProductAliasRule {
  aliasBase: string
  aliasVariant: string | null
  canonicalBase: string
  canonicalVariant: string | null
}

// Matches on the normalized columns (same ones the extraction path's own
// dedup check uses, see findOrCreateProduct) rather than raw base_model
// equality like mergeDuplicateProducts does - case/whitespace differences in
// how a rule is transcribed don't cause a false "no match" the way
// exact-string matching would.
function findProduct(db: DbClient, base: string, variant: string | null): Promise<number[]> {
  return findProductIdsByNormalizedName(
    db,
    normalizeBaseModel(base),
    variant === null ? null : normalizeVariantTier(variant),
  )
}

interface MergeVariantAliasesResult {
  renamed: number
  merged: number
  // Rules whose alias side matched nothing live - surfaced instead of
  // silently no-op'd so a transcription typo (or a rule already covered by
  // a prior run) is visible rather than assumed applied.
  noMatch: ProductAliasRule[]
}

export async function mergeProductVariantAliases(
  db: DbClient,
  rules: ProductAliasRule[],
  opts: { dryRun?: boolean } = {},
): Promise<MergeVariantAliasesResult> {
  let renamed = 0
  let merged = 0
  const noMatch: ProductAliasRule[] = []

  for (const rule of rules) {
    const aliasIds = await findProduct(db, rule.aliasBase, rule.aliasVariant)
    if (aliasIds.length === 0) {
      noMatch.push(rule)
      continue
    }

    for (const aliasId of aliasIds) {
      const existing = (await findProduct(db, rule.canonicalBase, rule.canonicalVariant)).filter((id) => id !== aliasId)

      if (existing.length > 0) {
        if (!opts.dryRun) await mergeDuplicateProduct(db, existing[0], aliasId)
        merged++
      } else {
        if (!opts.dryRun) {
          await db.query(
            `UPDATE products SET base_model = $1, base_model_normalized = $2, variant_tier = $3, variant_tier_normalized = $4 WHERE id = $5`,
            [
              rule.canonicalBase,
              normalizeBaseModel(rule.canonicalBase),
              rule.canonicalVariant,
              rule.canonicalVariant === null ? null : normalizeVariantTier(rule.canonicalVariant),
              aliasId,
            ],
          )
        }
        renamed++
      }
    }
  }

  return { renamed, merged, noMatch }
}
