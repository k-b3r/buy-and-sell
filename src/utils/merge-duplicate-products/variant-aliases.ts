import type { DbClient } from '../../platform/storage'
import { normalizeBaseModel, normalizeVariantTier } from '../../domains/marketplace'
import { mergeDuplicateProduct } from '../../domains/marketplace'

// Generalizes ./index.ts's CANONICAL_BASE_MODEL (base_model-only rename) to
// also move text between base_model and variant_tier - most of the
// duplicate-product cases found in the 2026-09-02 catalog scan are exactly
// that (e.g. "iPhone 14 Plus" [] should be "iPhone 14" [Plus]), which the
// simpler tool can't express since it only ever rewrites base_model and
// assumes variant_tier already matches between alias and canonical.
export interface ProductAliasRule {
  aliasBase: string
  aliasVariant: string | null
  canonicalBase: string
  canonicalVariant: string | null
}

// Matches on the normalized columns (same ones the extraction path's own
// dedup check uses, see storage/products.ts findOrCreateProduct) rather than
// raw base_model equality like ./index.ts's tool does - case/whitespace
// differences in how a rule is transcribed don't cause a false "no match"
// the way exact-string matching would.
async function findProduct(db: DbClient, base: string, variant: string | null): Promise<{ id: number }[]> {
  const result = (await db.query(
    `SELECT id FROM products WHERE base_model_normalized = $1 AND variant_tier_normalized IS NOT DISTINCT FROM $2`,
    [normalizeBaseModel(base), variant === null ? null : normalizeVariantTier(variant)],
  )) as { rows: { id: number }[] }
  return result.rows
}

export interface MergeVariantAliasesResult {
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
    const aliasRows = await findProduct(db, rule.aliasBase, rule.aliasVariant)
    if (aliasRows.length === 0) {
      noMatch.push(rule)
      continue
    }

    for (const row of aliasRows) {
      const existing = (await findProduct(db, rule.canonicalBase, rule.canonicalVariant)).filter((r) => r.id !== row.id)

      if (existing.length > 0) {
        if (!opts.dryRun) await mergeDuplicateProduct(db, existing[0].id, row.id)
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
              row.id,
            ],
          )
        }
        renamed++
      }
    }
  }

  return { renamed, merged, noMatch }
}
