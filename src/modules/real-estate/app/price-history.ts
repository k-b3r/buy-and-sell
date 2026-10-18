import type { DbClient } from '../../../platform/storage'
import type { Logger } from '../../../platform/logger'
import type { PriorPriceRow } from '../types'
import { getRealEstatePriceHistoryState, insertPriceHistoryAt, insertPriceHistoryNow } from '../store/price-history'

// Real estate only: every other category returns early at the probe, so the
// non-real-estate path pays nothing unless its price actually changed (and
// then one indexed SELECT). Best-effort by design - a failure here must never
// fail the listing refresh, so it is logged and swallowed.
export interface ListingPriceChange {
  listingId: string
  prior: PriorPriceRow | undefined
  newPrice: number | null
  newCurrency: string | null
}

export async function recordRealEstatePriceChange(
  db: DbClient,
  logger: Logger,
  change: ListingPriceChange,
): Promise<void> {
  const { listingId, prior, newPrice, newCurrency } = change
  if (!prior) return
  const oldPrice =
    prior.old_price_amount === null || prior.old_price_amount === undefined ? null : Number(prior.old_price_amount)
  if (oldPrice === newPrice) return
  try {
    const hasHistory = await getRealEstatePriceHistoryState(db, listingId)
    if (hasHistory === null) return
    if (!hasHistory) {
      await insertPriceHistoryAt(db, {
        listingId,
        price: oldPrice,
        currency: prior.old_price_currency,
        recordedAt: prior.old_first_seen_at,
      })
    }
    await insertPriceHistoryNow(db, { listingId, price: newPrice, currency: newCurrency })
  } catch (err) {
    logger.warn(
      `listing ${listingId} price-history write failed, continuing: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
