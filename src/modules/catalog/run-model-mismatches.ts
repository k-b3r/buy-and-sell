import type { Logger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import { findListingModelMismatches, matchedProductText, planMismatchReassignment } from './model-mismatch'
import { findProductIdsByNormalizedName, getProductMatchedListings, updateListingProductIds } from './product-storage'
import { normalizeBaseModel } from './products'

// Read-only by design, same as detect-generic-products - a full catalog scan
// is broad/heuristic enough (see model-mismatch.ts) that it belongs in front
// of a human before any row gets reassigned, not applied live. Each flagged
// row here is a candidate for the same manual fix already done once for
// listing 1000000000000002, not an auto-fix target.
export async function detectModelMismatches(db: DbClient, logger: Logger): Promise<void> {
  const rows = await getProductMatchedListings(db)
  let candidates = 0

  for (const row of rows) {
    const mismatches = findListingModelMismatches(row)
    if (mismatches.length === 0) continue

    candidates++
    logger.info(
      `listing ${row.listing_id} "${row.title}" -> product ${row.product_id} "${matchedProductText(row)}" | ` +
        mismatches
          .map((m) => `${m.prefix}: title=${m.titleNumbers.join(',')} product=${m.productNumbers.join(',')}`)
          .join('; '),
    )
  }

  logger.info(`${candidates} candidate(s) found out of ${rows.length} product-matched listings`)
}

// Same fix pattern already applied by hand once
// (listing 1000000000000002, S23 mis-grouped under an S26 product): reassign
// listings.product_id to the product whose name actually matches the
// title's model number, instead of the one detectModelMismatches
// flagged them under. Deliberately narrow — only acts when
// deriveTargetBaseModel resolves unambiguously AND that exact product
// already exists in the catalog; anything else is reported via `log` as
// skipped for a human to resolve rather than guessed at or auto-created.
export async function reassignModelMismatches(
  db: DbClient,
  log: (line: string) => void,
  dryRun: boolean,
): Promise<{ reassigned: number; skipped: number }> {
  const rows = await getProductMatchedListings(db)
  let reassigned = 0
  let skipped = 0
  const assignments: { id: string; productId: number }[] = []

  for (const row of rows) {
    const plan = planMismatchReassignment(row)
    if (plan.kind === 'consistent') continue
    if (plan.kind === 'multiple') {
      log(`skip listing ${row.listing_id}: several model prefixes mismatch, can't pick a single target base_model`)
      skipped++
      continue
    }
    if (plan.kind === 'ambiguous') {
      log(`skip listing ${row.listing_id}: ambiguous mismatch, can't derive a single target base_model`)
      skipped++
      continue
    }

    const { targetBaseModel } = plan
    const [targetProductId] = await findProductIdsByNormalizedName(
      db,
      normalizeBaseModel(targetBaseModel),
      row.variant_tier_normalized,
    )
    if (targetProductId === undefined) {
      log(`skip listing ${row.listing_id}: derived target "${targetBaseModel}" has no existing matching product`)
      skipped++
      continue
    }
    if (targetProductId === row.product_id) {
      log(
        `skip listing ${row.listing_id}: derived target "${targetBaseModel}" is already its product ${targetProductId}`,
      )
      skipped++
      continue
    }

    log(
      `${dryRun ? '[dry run] would reassign' : 'reassigning'} listing ${row.listing_id} "${row.title}": product ${row.product_id} "${row.base_model}" -> product ${targetProductId} "${targetBaseModel}"`,
    )
    assignments.push({ id: row.listing_id, productId: targetProductId })
    reassigned++
  }

  if (!dryRun && assignments.length > 0) await updateListingProductIds(db, assignments)

  return { reassigned, skipped }
}
