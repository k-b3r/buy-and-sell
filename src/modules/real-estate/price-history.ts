import type { DbClient } from '../../platform/storage'
import type { Logger } from '../../platform/logger'

// The listing's price before a refresh, as returned by the refresh UPDATE.
export interface PriorPriceRow {
  old_price_amount: string | number | null
  old_price_currency: string | null
  old_first_seen_at: string | Date
}

// Real estate only: every other category returns early at the probe, so the
// non-real-estate path pays nothing unless its price actually changed (and
// then one indexed SELECT). Best-effort by design - a failure here must never
// fail the listing refresh, so it is logged and swallowed.
export async function recordRealEstatePriceChange(
  db: DbClient,
  logger: Logger,
  listingId: string,
  prior: PriorPriceRow | undefined,
  newPrice: number | null,
  newCurrency: string | null,
): Promise<void> {
  if (!prior) return
  const oldPrice =
    prior.old_price_amount === null || prior.old_price_amount === undefined ? null : Number(prior.old_price_amount)
  if (oldPrice === newPrice) return
  try {
    const probe = (await db.query(
      `SELECT EXISTS (SELECT 1 FROM listing_price_history h WHERE h.listing_id = l.id) AS has_history
       FROM listings l
       JOIN products p ON p.id = l.product_id
       JOIN categories c ON c.id = p.category_id
       WHERE l.id = $1 AND c.name = 'Real Estate'`,
      [listingId],
    )) as { rows?: { has_history: boolean }[] } | undefined
    const row = probe?.rows?.[0]
    if (!row) return
    if (!row.has_history) {
      await db.query(
        `INSERT INTO listing_price_history (listing_id, price_amount, price_currency, recorded_at) VALUES ($1, $2, $3, $4)`,
        [listingId, oldPrice, prior.old_price_currency, prior.old_first_seen_at],
      )
    }
    await db.query(`INSERT INTO listing_price_history (listing_id, price_amount, price_currency) VALUES ($1, $2, $3)`, [
      listingId,
      newPrice,
      newCurrency,
    ])
  } catch (err) {
    logger.warn(
      `listing ${listingId} price-history write failed, continuing: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
