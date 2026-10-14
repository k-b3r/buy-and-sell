import type { DbClient } from '../../../platform/storage'

// null when the listing is not a real estate listing (or does not exist): the
// probe joins through products and categories, so every other category misses.
export async function getRealEstatePriceHistoryState(db: DbClient, listingId: string): Promise<boolean | null> {
  const probe = (await db.query(
    `SELECT EXISTS (SELECT 1 FROM listing_price_history h WHERE h.listing_id = l.id) AS has_history
       FROM listings l
       JOIN products p ON p.id = l.product_id
       JOIN categories c ON c.id = p.category_id
       WHERE l.id = $1 AND c.name = 'Real Estate'`,
    [listingId],
  )) as { rows?: { has_history: boolean }[] } | undefined
  const row = probe?.rows?.[0]
  return row ? row.has_history : null
}

// Backdated to when the listing was first seen: the baseline point for a
// listing that had no history before its first price change.
export async function insertPriceHistoryAt(
  db: DbClient,
  point: { listingId: string; price: number | null; currency: string | null; recordedAt: string | Date },
): Promise<void> {
  await db.query(
    `INSERT INTO listing_price_history (listing_id, price_amount, price_currency, recorded_at) VALUES ($1, $2, $3, $4)`,
    [point.listingId, point.price, point.currency, point.recordedAt],
  )
}

export async function insertPriceHistoryNow(
  db: DbClient,
  point: { listingId: string; price: number | null; currency: string | null },
): Promise<void> {
  await db.query(`INSERT INTO listing_price_history (listing_id, price_amount, price_currency) VALUES ($1, $2, $3)`, [
    point.listingId,
    point.price,
    point.currency,
  ])
}
