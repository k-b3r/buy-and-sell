export interface QueryClient {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>
}

export interface ProductSummary {
  id: number
  base_model: string
  variant_tier: string | null
  listing_count: number
  price_min: number | null
  price_max: number | null
  price_avg: number | null
  sample_photo_url: string | null
  market_price_low: number | null
  market_price_high: number | null
  market_price_source: string | null
}

const DEFAULT_LIMIT = 30

// Preference order for which market-price signal to surface: an external
// source (web_search/gemini_grounding) beats 'listing_prices', which is
// computed from this same marketplace's own listings and so is a more
// circular comparison (see db/schema.sql's product_price_history comment).
const MARKET_PRICE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT price_low, price_high, source
    FROM product_price_history h
    WHERE h.product_id = p.id
    ORDER BY (h.source != 'listing_prices') DESC, h.checked_at DESC
    LIMIT 1
  ) mp ON true
`

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

// A LEFT JOIN nulls every joined column when there's no matching row - since
// is_negotiable is NOT NULL in listing_price_review, that's the reliable
// "no review row exists" signal, same pattern as product_enrichment's join.
function toPriceReview(r: Record<string, unknown>): ListingPriceReview | null {
  if (r.price_review_is_negotiable === null || r.price_review_is_negotiable === undefined) return null
  return {
    is_negotiable: r.price_review_is_negotiable as boolean,
    price_low: toNullableNumber(r.price_review_low),
    price_high: toNullableNumber(r.price_review_high),
  }
}

export async function getProductSummaries(
  db: QueryClient,
  options: { search?: string; offset?: number; limit?: number } = {},
): Promise<ProductSummary[]> {
  const trimmedSearch = options.search?.trim()
  const search = trimmedSearch ? `%${trimmedSearch}%` : null
  const limit = options.limit ?? DEFAULT_LIMIT
  const offset = options.offset ?? 0

  const result = await db.query(
    `SELECT p.id, p.base_model, p.variant_tier,
            count(l.id) as listing_count,
            min(l.price_amount) as price_min,
            max(l.price_amount) as price_max,
            avg(l.price_amount) as price_avg,
            max(l.primary_photo_url) as sample_photo_url,
            mp.price_low as market_price_low,
            mp.price_high as market_price_high,
            mp.source as market_price_source
     FROM products p
     JOIN listings l ON l.product_id = p.id
     ${MARKET_PRICE_LATERAL}
     WHERE ($1::text IS NULL OR p.base_model ILIKE $1)
     GROUP BY p.id, p.base_model, p.variant_tier, mp.price_low, mp.price_high, mp.source
     ORDER BY listing_count DESC, p.id ASC
     LIMIT $2 OFFSET $3`,
    [search, limit, offset],
  )

  return (result.rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as number,
    base_model: r.base_model as string,
    variant_tier: r.variant_tier as string | null,
    listing_count: Number(r.listing_count),
    price_min: toNullableNumber(r.price_min),
    price_max: toNullableNumber(r.price_max),
    price_avg: toNullableNumber(r.price_avg),
    sample_photo_url: r.sample_photo_url as string | null,
    market_price_low: toNullableNumber(r.market_price_low),
    market_price_high: toNullableNumber(r.market_price_high),
    market_price_source: r.market_price_source as string | null,
  }))
}

export interface ListingPriceReview {
  is_negotiable: boolean
  price_low: number | null
  price_high: number | null
}

export interface ProductListingSummary {
  id: string
  title: string
  price_amount: number | null
  primary_photo_url: string | null
  condition: string | null
  sold_at: string | null
  price_review: ListingPriceReview | null
}

export interface ProductEnrichment {
  description: string
  value_drivers: string
  has_trained_price_knowledge: boolean
  trained_price_low: number | null
  trained_price_high: number | null
  trained_price_currency: string | null
  model: string
  checked_at: string
}

export interface ProductDetail {
  id: number
  base_model: string
  variant_tier: string | null
  market_price_low: number | null
  market_price_high: number | null
  market_price_source: string | null
  enrichment: ProductEnrichment | null
  listings: ProductListingSummary[]
}

export async function getProductDetail(db: QueryClient, productId: number): Promise<ProductDetail | null> {
  const productResult = await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, mp.price_low as market_price_low,
            mp.price_high as market_price_high, mp.source as market_price_source,
            e.description as enrichment_description, e.value_drivers as enrichment_value_drivers,
            e.has_trained_price_knowledge as enrichment_has_trained_price_knowledge,
            e.trained_price_low as enrichment_trained_price_low,
            e.trained_price_high as enrichment_trained_price_high,
            e.trained_price_currency as enrichment_trained_price_currency,
            e.model as enrichment_model, e.checked_at as enrichment_checked_at
     FROM products p
     ${MARKET_PRICE_LATERAL}
     LEFT JOIN product_enrichment e ON e.product_id = p.id
     WHERE p.id = $1`,
    [productId],
  )
  const productRow = (productResult.rows as Record<string, unknown>[])[0]
  if (!productRow) return null

  const enrichment: ProductEnrichment | null =
    productRow.enrichment_checked_at != null
      ? {
          description: productRow.enrichment_description as string,
          value_drivers: productRow.enrichment_value_drivers as string,
          has_trained_price_knowledge: productRow.enrichment_has_trained_price_knowledge as boolean,
          trained_price_low: toNullableNumber(productRow.enrichment_trained_price_low),
          trained_price_high: toNullableNumber(productRow.enrichment_trained_price_high),
          trained_price_currency: productRow.enrichment_trained_price_currency as string | null,
          model: productRow.enrichment_model as string,
          checked_at: toIsoOrNull(productRow.enrichment_checked_at) as string,
        }
      : null

  const listingsResult = await db.query(
    `SELECT l.id, l.title, l.price_amount, l.primary_photo_url, l.condition, l.sold_at,
            pr.is_negotiable as price_review_is_negotiable,
            pr.price_low as price_review_low, pr.price_high as price_review_high
     FROM listings l
     LEFT JOIN listing_price_review pr ON pr.listing_id = l.id
     WHERE l.product_id = $1
     ORDER BY l.title`,
    [productId],
  )
  const listings = (listingsResult.rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    price_amount: toNullableNumber(r.price_amount),
    primary_photo_url: r.primary_photo_url as string | null,
    condition: r.condition as string | null,
    sold_at: toIsoOrNull(r.sold_at),
    price_review: toPriceReview(r),
  }))

  return {
    id: productRow.id as number,
    base_model: productRow.base_model as string,
    variant_tier: productRow.variant_tier as string | null,
    market_price_low: toNullableNumber(productRow.market_price_low),
    market_price_high: toNullableNumber(productRow.market_price_high),
    market_price_source: productRow.market_price_source as string | null,
    enrichment,
    listings,
  }
}

export interface ListingDetail {
  id: string
  title: string
  price_amount: number | null
  price_currency: string | null
  description: string | null
  condition: string | null
  location_city: string | null
  listed_at: string | null
  photo_urls: string[]
  product_id: number | null
  base_model: string | null
  variant_tier: string | null
  sold_at: string | null
  price_review: ListingPriceReview | null
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : (value as string)
}

export async function getListingDetail(db: QueryClient, listingId: string): Promise<ListingDetail | null> {
  const result = await db.query(
    `SELECT l.id, l.title, l.price_amount, l.price_currency, l.description, l.condition,
            l.location_city, l.listed_at, l.primary_photo_url, l.stored_photo_urls, l.product_id,
            l.sold_at, p.base_model, p.variant_tier,
            pr.is_negotiable as price_review_is_negotiable,
            pr.price_low as price_review_low, pr.price_high as price_review_high
     FROM listings l
     LEFT JOIN products p ON p.id = l.product_id
     LEFT JOIN listing_price_review pr ON pr.listing_id = l.id
     WHERE l.id = $1`,
    [listingId],
  )
  const row = (result.rows as Record<string, unknown>[])[0]
  if (!row) return null

  const storedPhotoUrls = row.stored_photo_urls as string[] | null
  const photoUrls =
    storedPhotoUrls && storedPhotoUrls.length > 0
      ? storedPhotoUrls
      : row.primary_photo_url
        ? [row.primary_photo_url as string]
        : []

  return {
    id: row.id as string,
    title: row.title as string,
    price_amount: toNullableNumber(row.price_amount),
    price_currency: row.price_currency as string | null,
    description: row.description as string | null,
    condition: row.condition as string | null,
    location_city: row.location_city as string | null,
    listed_at: toIsoOrNull(row.listed_at),
    photo_urls: photoUrls,
    product_id: row.product_id as number | null,
    base_model: row.base_model as string | null,
    variant_tier: row.variant_tier as string | null,
    sold_at: toIsoOrNull(row.sold_at),
    price_review: toPriceReview(row),
  }
}
