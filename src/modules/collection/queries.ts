import type { QueryClient } from '../../platform/storage'
import { resolvePhotoUrls, toIsoOrNull, toNullableNumber } from '../../platform/rows'
import type { ComparableListing, ListingPriceReview } from '../pricing'
import {
  computeListingDiscount,
  getComparableListings,
  getPeerMedianPrice,
  getSoldComparablePrice,
  isPriceInvalidated,
  medianCtes,
  peerListingSql,
  toPriceReview,
} from '../pricing'

export interface ListingDetail {
  id: string
  title: string
  price_amount: number | null
  price_currency: string | null
  description: string | null
  condition: string | null
  location_city: string | null
  listed_at: string | null
  last_seen_at: string | null
  photo_urls: string[]
  product_id: number | null
  base_model: string | null
  variant_tier: string | null
  sold_at: string | null
  price_review: ListingPriceReview | null
  discount_percent: number | null
  reference_price: number | null
  is_saved: boolean
  verification_reasoning: string | null
  recent_sales: ComparableListing[]
  similar_listings: ComparableListing[]
}

// Same clean-median approach as getProductDetail's in-JS version, but as SQL
// since a single listing's siblings aren't already fetched here. Takes
// listingId (not product_id) and looks the product up itself via listings'
// PK - lets this run in parallel with the main row query below instead of
// waiting on its result. A listing with no product_id (or that doesn't
// exist) makes the subquery NULL, which the `product_id = NULL` filter
// never matches - no row comes back, the "no siblings" case getListingDetail
// already handles. Excluded products never get a median, same as the
// product page/list; same peer scope as every peer median.
const SIBLING_MEDIAN_SQL = `
  WITH ${medianCtes({
    name: 'product',
    pool: `SELECT l.product_id, l.price_amount FROM listings l
           JOIN products p ON p.id = l.product_id
           WHERE l.product_id = (SELECT product_id FROM listings WHERE id = $1) AND NOT p.price_lookup_excluded
             AND ${peerListingSql('l')}`,
  })}
  SELECT raw_median_price, sample_size, clean_median_price FROM product
`

export async function getListingDetail(db: QueryClient, listingId: string): Promise<ListingDetail | null> {
  const [result, medianResult] = await Promise.all([
    db.query(
      `SELECT l.id, l.title, l.price_amount, l.price_currency, l.description, l.condition,
              l.location_city, l.listed_at, l.last_seen_at, l.primary_photo_url, l.stored_photo_urls, l.product_id,
              l.sold_at, p.base_model, p.variant_tier,
              pr.is_negotiable as price_review_is_negotiable,
              pr.price_low as price_review_low, pr.price_high as price_review_high,
              sv.listing_id IS NOT NULL as is_saved,
              dn.verification_reasoning
       FROM listings l
       LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN listing_price_review pr ON pr.listing_id = l.id
       LEFT JOIN saved_listings sv ON sv.listing_id = l.id
       LEFT JOIN discount_notifications dn ON dn.listing_id = l.id AND dn.verified_at IS NOT NULL
       WHERE l.id = $1`,
      [listingId],
    ),
    db.query(SIBLING_MEDIAN_SQL, [listingId]),
  ])
  const row = (result.rows as Record<string, unknown>[])[0]
  if (!row) return null

  const photoUrls = resolvePhotoUrls(row.stored_photo_urls, row.primary_photo_url)

  const medianRow = (medianResult.rows as Record<string, unknown>[])[0]
  const rawMedian = medianRow ? toNullableNumber(medianRow.raw_median_price) : null
  const discount = medianRow
    ? computeListingDiscount(
        row.price_amount,
        medianRow.raw_median_price,
        medianRow.clean_median_price,
        medianRow.sample_size,
      )
    : { discountPercent: null, referencePrice: null }

  const priceAmount = toNullableNumber(row.price_amount)

  // Evidence panel: only populated when the tier's own min-sample threshold
  // (MIN_PEER_SAMPLE, n>=3, for both) is met - same
  // bar /deals uses to call something a real tier, so this page never shows
  // weaker evidence than what would've qualified the listing there.
  const productId = toNullableNumber(row.product_id)
  let recentSales: ComparableListing[] = []
  let similarListings: ComparableListing[] = []
  if (productId !== null) {
    const [soldComp, peerMedian, salesRows, similarRows] = await Promise.all([
      getSoldComparablePrice(db, productId),
      getPeerMedianPrice(db, productId),
      getComparableListings(db, { productId, excludeListingId: listingId, sold: true }),
      getComparableListings(db, { productId, excludeListingId: listingId, sold: false }),
    ])
    if (soldComp) recentSales = salesRows
    if (peerMedian) similarListings = similarRows
  }

  return {
    id: row.id as string,
    title: row.title as string,
    price_amount: priceAmount !== null && isPriceInvalidated(priceAmount, rawMedian) ? null : priceAmount,
    price_currency: row.price_currency as string | null,
    description: row.description as string | null,
    condition: row.condition as string | null,
    location_city: row.location_city as string | null,
    listed_at: toIsoOrNull(row.listed_at),
    last_seen_at: toIsoOrNull(row.last_seen_at),
    photo_urls: photoUrls,
    product_id: row.product_id as number | null,
    base_model: row.base_model as string | null,
    variant_tier: row.variant_tier as string | null,
    sold_at: toIsoOrNull(row.sold_at),
    price_review: toPriceReview(row),
    discount_percent: discount.discountPercent,
    reference_price: discount.referencePrice,
    is_saved: row.is_saved as boolean,
    verification_reasoning: row.verification_reasoning as string | null,
    recent_sales: recentSales,
    similar_listings: similarListings,
  }
}

// Dashboard-wide bookmark list (see db/schema.sql's saved_listings) - no
// per-user scoping, the dashboard has a single shared password.
export async function saveListing(db: QueryClient, listingId: string): Promise<void> {
  await db.query(`INSERT INTO saved_listings (listing_id) VALUES ($1) ON CONFLICT (listing_id) DO NOTHING`, [listingId])
}

export async function unsaveListing(db: QueryClient, listingId: string): Promise<void> {
  await db.query(`DELETE FROM saved_listings WHERE listing_id = $1`, [listingId])
}

export interface SavedListingSummary {
  id: string
  title: string
  price_amount: number | null
  primary_photo_url: string | null
  condition: string | null
  sold_at: string | null
  product_id: number | null
  base_model: string | null
  variant_tier: string | null
  saved_at: string
}

export async function getSavedListings(db: QueryClient): Promise<SavedListingSummary[]> {
  const result = await db.query(
    `SELECT l.id, l.title, l.price_amount, l.primary_photo_url, l.stored_photo_urls, l.condition, l.sold_at,
            l.product_id, p.base_model, p.variant_tier, sv.saved_at
     FROM saved_listings sv
     JOIN listings l ON l.id = sv.listing_id
     LEFT JOIN products p ON p.id = l.product_id
     ORDER BY sv.saved_at DESC`,
    [],
  )
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    price_amount: toNullableNumber(r.price_amount),
    primary_photo_url: resolvePhotoUrls(r.stored_photo_urls, r.primary_photo_url)[0] ?? null,
    condition: r.condition as string | null,
    sold_at: toIsoOrNull(r.sold_at),
    product_id: r.product_id as number | null,
    base_model: r.base_model as string | null,
    variant_tier: r.variant_tier as string | null,
    saved_at: toIsoOrNull(r.saved_at) as string,
  }))
}

// collect.ts's --cycle search-query list - editable via the Settings page's
// collect tab (add/remove rows, not per-field number knobs like the rest of
// settings, hence its own table/endpoint instead of a settings row).
export interface CollectKeyword {
  keyword: string
  enabled: boolean
}

export async function getCollectKeywords(db: QueryClient): Promise<CollectKeyword[]> {
  const result = await db.query(
    `SELECT keyword, enabled FROM collect_keywords WHERE kind = 'general' ORDER BY keyword`,
    [],
  )
  return (result.rows as CollectKeyword[]).map((r) => ({ keyword: r.keyword, enabled: r.enabled }))
}

// Full-list replace rather than a diffed add/remove - the table is a
// handful of rows edited rarely from one shared dashboard, so the simplicity
// of "save the whole list" outweighs the cost of a delete-then-insert.
export async function replaceCollectKeywords(db: QueryClient, keywords: CollectKeyword[]): Promise<void> {
  await db.query(`DELETE FROM collect_keywords WHERE kind = 'general'`, [])
  if (keywords.length === 0) return
  const valuesSql = keywords.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')
  const params = keywords.flatMap((k) => [k.keyword, k.enabled])
  await db.query(`INSERT INTO collect_keywords (keyword, enabled) VALUES ${valuesSql}`, params)
}

// The dashboard's refresh route busts the product-detail cache tag after a
// refresh and needs the listing's product id to name that tag. Trivial, but
// it still goes through the registry like everything else - the dashboard
// has no way to send SQL of its own (see routes/query.ts).
export async function getListingProductId(db: QueryClient, listingId: string): Promise<number | null> {
  const result = await db.query('SELECT product_id FROM listings WHERE id = $1', [listingId])
  const row = (result.rows as { product_id: number | null }[])[0]
  return row?.product_id ?? null
}
