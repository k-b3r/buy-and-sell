import type { DbClient, QueryClient } from '../../platform/storage'
import { resolvePhotoUrls, toIsoOrNull, toNullableNumber } from '../../platform/rows'
import { medianCtes, notMagnitudeOutlierSql } from './clean-median'

// Human-entered price for a needs_review product - outranks every automated
// source (see NEW_PRICE_LATERAL/SECONDHAND_PRICE_LATERAL) permanently, not
// just until the next automated run. Append-only like every other
// product_price_history writer; doesn't touch price_lookup_review_status
// itself (the API route pairs this with markProductReviewed).
export async function setManualPrice(
  db: QueryClient,
  productId: number,
  kind: 'new' | 'secondhand',
  priceLow: number,
  priceHigh: number,
): Promise<void> {
  const source = kind === 'new' ? 'manual_new_retail' : 'manual_secondhand'
  await db.query(
    `INSERT INTO product_price_history (product_id, price_low, price_high, price_currency, source)
     VALUES ($1, $2, $3, 'PHP', $4)`,
    [productId, priceLow, priceHigh, source],
  )
}

export interface ProductCleanMedian {
  medianPrice: number
  sampleSize: number
}

export type SoldComparablePrice = ProductCleanMedian

// Three or more independent sales before treating the median as a real
// signal rather than noise - one lucky/unlucky sold listing shouldn't
// anchor a reference price. Also the "sold_comps" confidence tier's bar for
// the deals page (highest tier; falls back to peer active-listing median,
// then an LLM estimate, when this returns null - see [deals page] once built).
export const SOLD_COMP_MIN_SAMPLE = 3

// Which of a product's listings a clean median is taken over: sold ones
// (what it was asking when it sold), active ones (what competing sellers ask
// right now), or both.
export type ListingScope = 'sold' | 'active' | 'all'

const SCOPE_SQL: Record<ListingScope, string> = {
  sold: 'pl.sold_at IS NOT NULL',
  active: 'pl.sold_at IS NULL',
  all: 'true',
}

// One product's clean median over its listings in scope, excluded products
// never priced - null below minSample valid prices. Backs the sold-comp and
// peer reference prices here and discount detection's peer fallback.
export async function getProductCleanMedian(
  db: DbClient,
  productId: number,
  options: { scope: ListingScope; minSample: number },
): Promise<ProductCleanMedian | null> {
  const result = (await db.query(
    `WITH ${medianCtes({
      name: 'product',
      pool: `SELECT pl.product_id, pl.price_amount FROM listings pl
             JOIN products p ON p.id = pl.product_id
             WHERE pl.product_id = $1 AND ${SCOPE_SQL[options.scope]} AND NOT p.price_lookup_excluded`,
      minSample: options.minSample,
    })}
    SELECT sample_size, clean_median_price FROM product`,
    [productId],
  )) as { rows: Record<string, unknown>[] }
  const row = result.rows[0]
  if (!row) return null

  const sampleSize = Number(row.sample_size)
  const medianPrice = toNullableNumber(row.clean_median_price)
  if (sampleSize < options.minSample || medianPrice === null || medianPrice <= 0) return null

  return { medianPrice, sampleSize }
}

// Listings Facebook has actually marked sold (sold_at IS NOT NULL) instead
// of current asking prices - a real transacted-market signal, not just what
// someone's currently hoping to get. Facebook doesn't expose the actual
// agreed sale price logged-out, so this is "what it was asking when it
// sold," not a true transaction price - still materially better than an
// active listing's ask, which nobody has paid yet.
export async function getSoldComparablePrice(db: QueryClient, productId: number): Promise<SoldComparablePrice | null> {
  return getProductCleanMedian(db, productId, { scope: 'sold', minSample: SOLD_COMP_MIN_SAMPLE })
}

export type PeerMedianPrice = ProductCleanMedian

// Deals page's second-tier reference price: median of *active* (still-listed,
// nobody's paid yet) peer listings of the same product, used when
// getSoldComparablePrice above has too few actual sales to trust. Two
// listings is enough here (vs SOLD_COMP_MIN_SAMPLE's 3) since this is already
// the fallback tier - demanding the same bar as sold comps would just push
// more products down to the even-less-precise LLM-estimate tier.
export const PEER_MEDIAN_MIN_SAMPLE = 2

// Scoped to active listings (sold_at IS NULL) instead of sold ones - "what
// competing sellers are asking right now" rather than "what last actually
// sold". Per-product so the deals page can call this once per product
// instead of once per listing.
export async function getPeerMedianPrice(db: QueryClient, productId: number): Promise<PeerMedianPrice | null> {
  return getProductCleanMedian(db, productId, { scope: 'active', minSample: PEER_MEDIAN_MIN_SAMPLE })
}

export interface ComparableListing {
  listing_id: string
  title: string
  price_amount: number
  photo_url: string | null
  date: string | null
}

const COMPARABLE_LISTINGS_DEFAULT_LIMIT = 6

// Backs the listing-detail page's "recent sales" / "similar listings"
// evidence panel - the actual rows behind getSoldComparablePrice/
// getPeerMedianPrice's clean median, not just the aggregate number. Callers
// gate on those two functions' own min-sample thresholds first (this
// function doesn't re-check n>=3/n>=2 itself) so a listing never claims
// evidence weaker than what actually qualified it for a /deals tier.
export async function getComparableListings(
  db: QueryClient,
  productId: number,
  excludeListingId: string,
  sold: boolean,
  limit: number = COMPARABLE_LISTINGS_DEFAULT_LIMIT,
): Promise<ComparableListing[]> {
  const soldClause = sold ? 'pl.sold_at IS NOT NULL' : 'pl.sold_at IS NULL'
  const dateColumn = sold ? 'pl.sold_at' : 'pl.listed_at'

  const result = await db.query(
    `WITH ${medianCtes({
      name: 'product',
      pool: `SELECT pl.product_id, pl.id, pl.title, pl.price_amount, pl.primary_photo_url, pl.stored_photo_urls, ${dateColumn} AS date
             FROM listings pl
             JOIN products p ON p.id = pl.product_id
             WHERE pl.product_id = $1 AND pl.id != $2 AND ${soldClause} AND NOT p.price_lookup_excluded`,
      clean: false,
    })}
     SELECT pp.id AS listing_id, pp.title, pp.price_amount, pp.primary_photo_url, pp.stored_photo_urls, pp.date
     FROM product_prices pp
     JOIN product m ON m.product_id = pp.product_id
     WHERE ${notMagnitudeOutlierSql('pp.price_amount', 'm.raw_median_price')}
     ORDER BY pp.date DESC NULLS LAST
     LIMIT $3`,
    [productId, excludeListingId, limit],
  )

  return (result.rows as Record<string, unknown>[]).map((r) => ({
    listing_id: r.listing_id as string,
    title: r.title as string,
    price_amount: Number(r.price_amount),
    photo_url: resolvePhotoUrls(r.stored_photo_urls, r.primary_photo_url)[0] ?? null,
    date: toIsoOrNull(r.date),
  }))
}

export interface DiscountNotification {
  id: number
  listing_id: string
  product_id: number
  title: string | null
  primary_photo_url: string | null
  discount_percent: number
  reference_price: number
  created_at: string
  read_at: string | null
  verification_reasoning: string | null
}

// Written by the root pipeline's detectAndRecordDiscountNotifications (see
// discount-notifications.ts) right after a listing first
// gets a product_id - not queried live here, just displayed. No
// unstable_cache wrapper (unlike most of cachedQueries.ts): a bell badge
// showing a stale count defeats the point, and this table is small/indexed
// enough that a plain read is cheap.
export async function getDiscountNotifications(db: QueryClient, limit = 20): Promise<DiscountNotification[]> {
  const result = await db.query(
    `SELECT dn.id, dn.listing_id, dn.product_id, l.title, l.primary_photo_url, l.stored_photo_urls,
            dn.discount_percent, dn.reference_price, dn.created_at, dn.read_at, dn.verification_reasoning
     FROM discount_notifications dn
     JOIN listings l ON l.id = dn.listing_id
     WHERE dn.verified_at IS NOT NULL
     ORDER BY dn.created_at DESC
     LIMIT $1`,
    [limit],
  )
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    listing_id: r.listing_id as string,
    product_id: Number(r.product_id),
    title: r.title as string | null,
    primary_photo_url: resolvePhotoUrls(r.stored_photo_urls, r.primary_photo_url)[0] ?? null,
    discount_percent: Number(r.discount_percent),
    reference_price: Number(r.reference_price),
    created_at: toIsoOrNull(r.created_at) as string,
    read_at: toIsoOrNull(r.read_at),
    verification_reasoning: r.verification_reasoning as string | null,
  }))
}

export async function getUnreadDiscountNotificationCount(db: QueryClient): Promise<number> {
  const result = await db.query(
    `SELECT count(*) AS count FROM discount_notifications WHERE read_at IS NULL AND verified_at IS NOT NULL`,
    [],
  )
  return Number((result.rows as { count: string }[])[0].count)
}

export async function markDiscountNotificationRead(db: QueryClient, id: number): Promise<void> {
  await db.query(`UPDATE discount_notifications SET read_at = now() WHERE id = $1 AND read_at IS NULL`, [id])
}

export async function markAllDiscountNotificationsRead(db: QueryClient): Promise<void> {
  await db.query(`UPDATE discount_notifications SET read_at = now() WHERE read_at IS NULL`, [])
}
