import type { DbClient } from '../../../platform/storage'
import type { ProductAliasRule } from '../types'
import { CANONICAL_BASE_MODEL, normalizeBaseModel, normalizeVariantTier } from '../domain/products'
import {
  findProductIdsByNormalizedName,
  findProductsByBaseModel,
  mergeDuplicateProduct,
  renameProduct,
  renameProductBaseModel,
} from '../store/products'

// Retroactive fix for duplicates CANONICAL_BASE_MODEL now prevents at
// extraction time. Renames in place when nothing collides. When the
// canonical name + same variant already exists as a different row (the
// common case, that's WHY these were split), merges into it instead of
// renaming, since the products_base_model_variant_normalized_idx unique index
// would otherwise reject the rename outright. The collision lookup uses that
// index's normalized identity, so a canonical row differing only in case or
// spacing is still found.
export async function mergeDuplicateProducts(
  db: DbClient,
  {
    canonicalMap = CANONICAL_BASE_MODEL,
    dryRun = false,
  }: { canonicalMap?: Record<string, string>; dryRun?: boolean } = {},
): Promise<{ renamed: number; merged: number }> {
  let renamed = 0
  let merged = 0

  for (const [alias, canonical] of Object.entries(canonicalMap)) {
    for (const row of await findProductsByBaseModel(db, alias)) {
      const existing = (
        await findProductIdsByNormalizedName(db, normalizeBaseModel(canonical), row.variant_tier_normalized)
      ).filter((id) => id !== row.id)

      if (existing.length > 0) {
        if (!dryRun) await mergeDuplicateProduct(db, existing[0], row.id)
        merged++
      } else {
        if (!dryRun) await renameProductBaseModel(db, row.id, canonical)
        renamed++
      }
    }
  }

  return { renamed, merged }
}

// Matches on the normalized columns (same ones the extraction path's own
// dedup check uses, see findOrCreateProduct) rather than raw text equality -
// case/whitespace differences in how a rule is transcribed don't cause a
// false "no match" the way exact-string matching would.
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
          await renameProduct(db, aliasId, { baseModel: rule.canonicalBase, variantTier: rule.canonicalVariant })
        }
        renamed++
      }
    }
  }

  return { renamed, merged, noMatch }
}
