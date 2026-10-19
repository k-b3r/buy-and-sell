import type { DbClient } from '../../../platform/storage'
import type { TriageConfidence } from '../types'
import { includeInPricing } from '../store/exclusion'
import { getRetryVerdictProductIds, getTriagedReasons, markTriageApplied } from '../store/price-triage'

// One-off LLM triage of products excluded from price lookup (BUY-60): per
// product a verdict (retry the lookup or keep it excluded) plus a rough
// new-retail estimate, logged to product_pricing_triage. Nothing changes
// pricing until a human reviews the log and runs applyTriageVerdicts.

const CONFIDENCE_RANK: Record<TriageConfidence, number> = { low: 1, medium: 2, high: 3 }

// A typo'd reason would otherwise match nothing and look like a clean run.
async function assertKnownReasons(db: DbClient, reasons: string[]): Promise<void> {
  const known = new Set(await getTriagedReasons(db))
  const unknown = reasons.filter((r) => !known.has(r))
  if (unknown.length > 0) {
    throw new Error(`unknown reason(s): ${unknown.join(', ')}. Triaged reasons: ${[...known].sort().join(', ')}`)
  }
}

// The reviewed step: every unapplied "retry" verdict at or above minConfidence
// goes through includeInPricing (BUY-36: retry for failed searches, override
// for judgments). Idempotent: applied_at marks what's done. A crash between
// the include and the applied_at write is safe: the next run re-includes, and
// includeInPricing leaves an already-included product alone. Returns the count.
// `reasons` limits it to products whose old exclusion reason is listed (the
// reviewed groups); omitted means every reason. A human's manual_review
// exclusion is never overturned, listed or not.
export async function applyTriageVerdicts(
  db: DbClient,
  minConfidence: TriageConfidence,
  reasons?: string[],
): Promise<number> {
  if (reasons) await assertKnownReasons(db, reasons)
  const productIds = await getRetryVerdictProductIds(db, CONFIDENCE_RANK[minConfidence], reasons)
  for (const productId of productIds) {
    await includeInPricing(db, productId)
    await markTriageApplied(db, productId)
  }
  return productIds.length
}
