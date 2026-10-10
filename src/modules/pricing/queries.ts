import type { DbClient, QueryClient } from '../../platform/storage'
import { resolvePhotoUrls, toIsoOrNull, toNullableNumber } from '../../platform/rows'
import { medianCtes, notMagnitudeOutlierSql, peerListingSql } from './clean-median'
import { LOOKUP_OUTCOME_REASONS } from './exclusion'

// Human-entered price for a needs_review product - outranks every automated
// source (see NEW_PRICE_LATERAL/SECONDHAND_PRICE_LATERAL) permanently, not
// just until the next automated run. Append-only like every other
// product_price_history writer; doesn't touch price_lookup_review_status
// itself (the API route pairs this with markProductReviewed).
interface ManualPrice {
  kind: 'new' | 'secondhand'
  priceLow: number
  priceHigh: number
}

// price arrives over the dashboard RPC as untrusted JSON. Checked here so a
// dashboard still sending the old positional args (kind, low, high) during a
// deploy fails loudly instead of inserting a null-priced manual row.
function isManualPrice(price: unknown): price is ManualPrice {
  if (typeof price !== 'object' || price === null) return false
  const { kind, priceLow, priceHigh } = price as Record<string, unknown>
  return (
    (kind === 'new' || kind === 'secondhand') &&
    typeof priceLow === 'number' &&
    Number.isFinite(priceLow) &&
    typeof priceHigh === 'number' &&
    Number.isFinite(priceHigh)
  )
}

export async function setManualPrice(db: QueryClient, productId: number, price: ManualPrice): Promise<void> {
  if (!isManualPrice(price)) throw new Error('setManualPrice: expected { kind, priceLow, priceHigh }')
  const { kind, priceLow, priceHigh } = price
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

// Which of a product's listings a clean median is taken over: sold ones
// (what it was asking when it sold) or peers (see peerListingSql).
export type ListingScope = 'sold' | 'peer'

const SCOPE_SQL: Record<ListingScope, string> = {
  sold: 'pl.sold_at IS NOT NULL',
  peer: peerListingSql('pl'),
}

// One product's clean median over its listings in scope, excluded products
// never priced - null below MIN_PEER_SAMPLE valid prices (medianCtes). Backs
// the sold-comp and peer reference prices here and discount detection's peer
// fallback.
export async function getProductCleanMedian(
  db: DbClient,
  productId: number,
  options: { scope: ListingScope },
): Promise<ProductCleanMedian | null> {
  const result = (await db.query(
    `WITH ${medianCtes({
      name: 'product',
      pool: `SELECT pl.product_id, pl.price_amount FROM listings pl
             JOIN products p ON p.id = pl.product_id
             WHERE pl.product_id = $1 AND ${SCOPE_SQL[options.scope]} AND NOT p.price_lookup_excluded`,
    })}
    SELECT sample_size, clean_median_price FROM product`,
    [productId],
  )) as { rows: Record<string, unknown>[] }
  const row = result.rows[0]
  if (!row) return null

  const sampleSize = Number(row.sample_size)
  const medianPrice = toNullableNumber(row.clean_median_price)
  if (medianPrice === null || medianPrice <= 0) return null

  return { medianPrice, sampleSize }
}

// Listings Facebook has actually marked sold (sold_at IS NOT NULL) instead
// of current asking prices - a real transacted-market signal, not just what
// someone's currently hoping to get. Facebook doesn't expose the actual
// agreed sale price logged-out, so this is "what it was asking when it
// sold," not a true transaction price - still materially better than an
// active listing's ask, which nobody has paid yet. The deals page's highest
// "sold_comps" confidence tier.
export async function getSoldComparablePrice(db: QueryClient, productId: number): Promise<SoldComparablePrice | null> {
  return getProductCleanMedian(db, productId, { scope: 'sold' })
}

export type PeerMedianPrice = ProductCleanMedian

// Deals page's second-tier reference price: median of the same product's peer
// listings (active plus recently sold or removed, see peerListingSql), used when
// getSoldComparablePrice above has too few actual sales to trust.
// Per-product so the deals page can call this once per product instead of
// once per listing.
export async function getPeerMedianPrice(db: QueryClient, productId: number): Promise<PeerMedianPrice | null> {
  return getProductCleanMedian(db, productId, { scope: 'peer' })
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
// getPeerMedianPrice's clean median, not just the aggregate number. Empty
// below MIN_PEER_SAMPLE comparables (no median, nothing to show as evidence).
interface ComparableListingsQuery {
  productId: number
  excludeListingId: string
  sold: boolean
  limit?: number
}

export async function getComparableListings(
  db: QueryClient,
  { productId, excludeListingId, sold, limit = COMPARABLE_LISTINGS_DEFAULT_LIMIT }: ComparableListingsQuery,
): Promise<ComparableListing[]> {
  const scopeClause = SCOPE_SQL[sold ? 'sold' : 'peer']
  const dateColumn = sold ? 'pl.sold_at' : 'pl.listed_at'

  const result = await db.query(
    `WITH ${medianCtes({
      name: 'product',
      pool: `SELECT pl.product_id, pl.id, pl.title, pl.price_amount, pl.primary_photo_url, pl.stored_photo_urls, ${dateColumn} AS date
             FROM listings pl
             JOIN products p ON p.id = pl.product_id
             WHERE pl.product_id = $1 AND pl.id != $2 AND ${scopeClause} AND NOT p.price_lookup_excluded`,
      clean: false,
    })}
     SELECT pp.id AS listing_id, pp.title, pp.price_amount, pp.primary_photo_url, pp.stored_photo_urls, pp.date
     FROM product_prices pp
     JOIN product m ON m.product_id = pp.product_id
     WHERE m.raw_median_price IS NOT NULL AND ${notMagnitudeOutlierSql('pp.price_amount', 'm.raw_median_price')}
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

export interface ExclusionReasonCount {
  reason: string
  count: number
  // true: a failed price search, so including the product retries the lookup.
  retry: boolean
}

// Excluded view's reason groups, biggest first.
export async function getExclusionSummary(db: QueryClient): Promise<ExclusionReasonCount[]> {
  const result = (await db.query(
    `SELECT COALESCE(price_lookup_excluded_reason, 'unknown') AS reason, count(*)::int AS count,
            COALESCE(price_lookup_excluded_reason = ANY($1), false) AS retry
     FROM products WHERE price_lookup_excluded
     GROUP BY 1, 3 ORDER BY 2 DESC, 1`,
    [[...LOOKUP_OUTCOME_REASONS]],
  )) as { rows: ExclusionReasonCount[] }
  return result.rows
}

export interface ExcludedProduct {
  id: number
  base_model: string
  variant_tier: string | null
  listing_count: number
}

const EXCLUDED_PAGE_SIZE = 50

// One reason's excluded products, most listings first: the ones whose
// missing price hides the most.
export async function getExcludedProducts(
  db: QueryClient,
  reason: string,
  options: { offset?: number; limit?: number } = {},
): Promise<ExcludedProduct[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, count(l.id)::int AS listing_count
     FROM products p LEFT JOIN listings l ON l.product_id = p.id
     WHERE p.price_lookup_excluded AND COALESCE(p.price_lookup_excluded_reason, 'unknown') = '${reason}'
     GROUP BY p.id ORDER BY listing_count DESC, p.base_model
     LIMIT $1 OFFSET $2`,
    [options.limit ?? EXCLUDED_PAGE_SIZE, options.offset ?? 0],
  )) as { rows: ExcludedProduct[] }
  return result.rows
}
