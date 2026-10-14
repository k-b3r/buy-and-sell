import type { QueryClient } from '../../../platform/storage'
import { resolvePhotoUrls, toIsoOrNull, toNullableNumber } from '../../../platform/rows'
import { medianCtes, peerListingSql } from '../../pricing'

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

type Row = Record<string, unknown>

export async function getListingDetailRow(db: QueryClient, listingId: string): Promise<Row | undefined> {
  const result = await db.query(
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
  )
  return (result.rows as Row[])[0]
}

export async function getSiblingMedianRow(db: QueryClient, listingId: string): Promise<Row | undefined> {
  const result = await db.query(SIBLING_MEDIAN_SQL, [listingId])
  return (result.rows as Row[])[0]
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

// The server's listing refresh route needs the listing's product id to name
// the product cache tag it drops after a refresh.
export async function getListingProductId(db: QueryClient, listingId: string): Promise<number | null> {
  const result = await db.query('SELECT product_id FROM listings WHERE id = $1', [listingId])
  const row = (result.rows as { product_id: number | null }[])[0]
  return row?.product_id ?? null
}
