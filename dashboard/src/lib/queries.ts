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
  new_price_low: number | null
  new_price_high: number | null
  secondhand_price_low: number | null
  secondhand_price_high: number | null
  secondhand_price_source: string | null
  best_discount_percent: number | null
  discounted_listing_count: number
  discount_bands: DiscountBand[]
}

export interface DiscountBand {
  bandFloor: number
  count: number
}

export interface DiscountSummary {
  bestDiscountPercent: number | null
  discountedListingCount: number
  bands: DiscountBand[]
}

// Single-digit discounts (1-9%) aren't a real deal signal worth surfacing -
// floor is 10%, per direct instruction (2026-08-23). Bands are decade-wide
// (10-19%, 20-29%, ...), only non-empty bands included, descending order -
// the actual spread of what a product has, not a fixed pre-declared list.
export function summarizeDiscounts(discountPercents: (number | null)[]): DiscountSummary {
  const qualifying = discountPercents.filter((d): d is number => d !== null && d >= 10)
  if (qualifying.length === 0) return { bestDiscountPercent: null, discountedListingCount: 0, bands: [] }

  const counts = new Map<number, number>()
  for (const d of qualifying) {
    const bandFloor = Math.floor(d / 10) * 10
    counts.set(bandFloor, (counts.get(bandFloor) ?? 0) + 1)
  }
  const bands = [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([bandFloor, count]) => ({ bandFloor, count }))

  return { bestDiscountPercent: Math.max(...qualifying), discountedListingCount: qualifying.length, bands }
}

const DEFAULT_LIMIT = 30

// exa_new_retail is the only source that has ever targeted brand-new retail
// pricing - gemini_grounding and web_search both explicitly ask for
// secondhand/used pricing (see src/pricing.ts's prompt), and Exa itself
// can't reach secondhand listings at all (FB/Carousell aren't indexed,
// confirmed live 2026-08-22 - see CONTEXT.md). Blending these into one
// "market price" number was a real bug: a product's new-retail price would
// silently make every real secondhand listing look like a huge deal against
// full retail. Kept as two separate laterals so the two concepts can never
// collapse into one column again.
const NEW_PRICE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT price_low, price_high
    FROM product_price_history h
    WHERE h.product_id = p.id AND h.source = 'exa_new_retail'
    ORDER BY h.checked_at DESC
    LIMIT 1
  ) np ON true
`

// gemini_grounding/web_search are external secondhand-grounded searches,
// preferred over listing_prices, which is computed from this same
// marketplace's own listings and so is a more circular comparison (see
// db/schema.sql's product_price_history comment).
const SECONDHAND_PRICE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT price_low, price_high, source
    FROM product_price_history h
    WHERE h.product_id = p.id AND h.source IN ('gemini_grounding', 'web_search', 'listing_prices')
    ORDER BY (h.source = 'listing_prices') ASC, h.checked_at DESC
    LIMIT 1
  ) up ON true
`

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

// jsonb_agg over an empty/filtered-out set comes back as SQL NULL, not '[]'.
function toDiscountBands(value: unknown): DiscountBand[] {
  if (!Array.isArray(value)) return []
  return value.map((b) => ({
    bandFloor: Number((b as { bandFloor: unknown }).bandFloor),
    count: Number((b as { count: unknown }).count),
  }))
}

// Same raw-median-then-outlier-excluded-clean-median approach as
// computeListingDiscount, computed once per product for the products-list
// page: "best deal under this product" is the single most actionable
// indicator (the point of this dashboard is spotting deals, not showing an
// average), paired with a count of how many listings actually qualify as
// discounted, so "one great deal buried among ten normal ones" reads
// differently from "most of them are discounted." Only positive discounts
// count - a product where everything's priced at/above the median has no
// deal to advertise.

// SQL equivalent of isPlaceholderPrice below - a single source-of-truth
// snippet so the three SQL call sites (DISCOUNT_SUMMARY_LATERAL,
// SIBLING_MEDIAN_SQL, and the price_min/max/avg aggregates) can't drift from
// each other or from the JS version used by getProductDetail.
function notPlaceholderPriceSql(column: string): string {
  return `NOT (
    length(trunc(${column})::text) >= 3
    AND (
      trunc(${column})::text ~ '^(\\d+)\\1+$'
      OR trunc(${column})::text = left('123456789', length(trunc(${column})::text))
    )
  )`
}

const DISCOUNT_SUMMARY_LATERAL = `
  LEFT JOIN LATERAL (
    WITH product_prices AS (
      -- price_lookup_excluded gated here, not just on the final aggregate
      -- below: the "bands" CTE further down is computed independently of
      -- that later WHERE (CTEs materialize before it's applied), so an
      -- excluded product's real discount_bands leaked through even after
      -- best_discount_percent/discounted_listing_count correctly went null.
      -- Confirmed live 2026-08-23: "House and Lot"/"Item"/"Desktop PC" all
      -- still showed real band arrays despite being flagged excluded.
      SELECT price_amount FROM listings pl
      WHERE pl.product_id = p.id AND pl.price_amount IS NOT NULL AND pl.price_amount > 0
        AND NOT p.price_lookup_excluded
        AND ${notPlaceholderPriceSql('pl.price_amount')}
    ),
    raw AS (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_amount) AS median_price, count(*) AS n
      FROM product_prices
    ),
    clean AS (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pp.price_amount) AS median_price
      FROM product_prices pp, raw
      WHERE raw.n >= 2 AND raw.median_price > 0
        AND pp.price_amount BETWEEN raw.median_price / 10 AND raw.median_price * 10
    ),
    discounts AS (
      SELECT round(((clean.median_price - pp.price_amount) / clean.median_price) * 100) AS discount_percent
      FROM product_prices pp, raw, clean
      WHERE raw.n >= 2 AND raw.median_price > 0 AND clean.median_price > 0
        AND pp.price_amount BETWEEN raw.median_price / 10 AND raw.median_price * 10
    ),
    -- Single-digit discounts (1-9%) aren't a real deal signal - floor is
    -- 10%, per direct instruction (2026-08-23), mirrored in summarizeDiscounts.
    qualifying AS (
      SELECT discount_percent FROM discounts WHERE discount_percent >= 10
    ),
    bands AS (
      SELECT (floor(discount_percent / 10) * 10)::int AS band_floor, count(*) AS band_count
      FROM qualifying
      GROUP BY band_floor
    )
    SELECT
      MAX(discount_percent) AS best_discount_percent,
      COUNT(*) AS discounted_listing_count,
      (SELECT jsonb_agg(jsonb_build_object('bandFloor', band_floor, 'count', band_count) ORDER BY band_floor DESC) FROM bands) AS discount_bands
    FROM qualifying
  ) ds ON true
`

// Classic "fake price to get attention" patterns real sellers use as
// placeholders - ascending-sequential digit runs (123, 12345), repeated-
// digit runs (111, 9999), and repeated multi-digit blocks (6969, 696969 -
// joke/meme numbers). Distinct from magnitude-outlier detection: found live
// 2026-08-23 that ₱123,456 fell well within the 10x magnitude threshold of
// a real ₱150,000 median yet is obviously not a real ask (it produced a
// nonsensical -626% "discount"). Deliberately narrow - round numbers like
// 500/1000/15000 are extremely common REAL prices in this marketplace and
// must not be flagged. Minimum length 3 for the same reason (₱11, ₱99 are
// plausible real small-item prices).
export function isPlaceholderPrice(price: number): boolean {
  const digits = String(Math.trunc(Math.abs(price)))
  if (digits.length < 3) return false
  if (/^(\d+)\1+$/.test(digits)) return true
  return digits === '123456789'.slice(0, digits.length)
}

// Same magnitude-outlier heuristic as src/db.ts's getPriceReviewCandidates
// (>10x or <0.1x the raw median) - a listing that far out is a placeholder
// price ("for attention only", "for swap"), not a real ask, so it gets no
// discount shown and is excluded from the reference price itself (a single
// ₱999,999,999 placeholder would otherwise blow up a plain average).
// rawMedianPrice decides whether THIS listing is an outlier; cleanMedianPrice
// (computed with outliers already excluded) is the actual reference used for
// the percentage, so the reference isn't itself skewed by the outliers it's
// meant to be filtering out.
export function computeListingDiscount(
  priceAmount: unknown,
  rawMedianPrice: unknown,
  cleanMedianPrice: unknown,
  sampleSize: unknown,
): { discountPercent: number | null; referencePrice: number | null } {
  const price = toNullableNumber(priceAmount)
  const n = toNullableNumber(sampleSize)
  const rawMedian = toNullableNumber(rawMedianPrice)
  const cleanMedian = toNullableNumber(cleanMedianPrice)
  const NONE = { discountPercent: null, referencePrice: null }

  if (price === null || n === null || n < 2) return NONE
  if (rawMedian === null || rawMedian <= 0 || cleanMedian === null || cleanMedian <= 0) return NONE
  if (price < rawMedian / 10 || price > rawMedian * 10) return NONE
  if (isPlaceholderPrice(price)) return NONE

  return { discountPercent: Math.round(((cleanMedian - price) / cleanMedian) * 100), referencePrice: cleanMedian }
}

// Third and last fallback tier for secondhand price, below the two external
// sources in SECONDHAND_PRICE_LATERAL: Groq's own trained-knowledge guess
// (product_enrichment.trained_price_*) is explicitly scoped to secondhand
// too (see src/enrichment.ts's prompt) - unverified/no live grounding, but
// still the right *kind* of number, unlike gemini_grounding/web_search which
// simply may not exist yet for a given product.
function resolveSecondhandPrice(
  usedLow: unknown,
  usedHigh: unknown,
  usedSource: unknown,
  hasTrainedPriceKnowledge: unknown,
  trainedLow: unknown,
  trainedHigh: unknown,
): { low: number | null; high: number | null; source: string | null } {
  if (usedLow !== null && usedLow !== undefined) {
    return { low: toNullableNumber(usedLow), high: toNullableNumber(usedHigh), source: usedSource as string }
  }
  if (hasTrainedPriceKnowledge === true) {
    return { low: toNullableNumber(trainedLow), high: toNullableNumber(trainedHigh), source: 'groq_trained' }
  }
  return { low: null, high: null, source: null }
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
            min(l.price_amount) FILTER (WHERE ${notPlaceholderPriceSql('l.price_amount')}) as price_min,
            max(l.price_amount) FILTER (WHERE ${notPlaceholderPriceSql('l.price_amount')}) as price_max,
            avg(l.price_amount) FILTER (WHERE ${notPlaceholderPriceSql('l.price_amount')}) as price_avg,
            max(l.primary_photo_url) as sample_photo_url,
            np.price_low as new_price_low,
            np.price_high as new_price_high,
            up.price_low as used_price_low,
            up.price_high as used_price_high,
            up.source as used_price_source,
            e.has_trained_price_knowledge,
            e.trained_price_low,
            e.trained_price_high,
            ds.best_discount_percent,
            ds.discounted_listing_count,
            ds.discount_bands
     FROM products p
     JOIN listings l ON l.product_id = p.id
     ${NEW_PRICE_LATERAL}
     ${SECONDHAND_PRICE_LATERAL}
     ${DISCOUNT_SUMMARY_LATERAL}
     LEFT JOIN product_enrichment e ON e.product_id = p.id
     WHERE ($1::text IS NULL OR p.base_model ILIKE $1)
     GROUP BY p.id, p.base_model, p.variant_tier, np.price_low, np.price_high,
              up.price_low, up.price_high, up.source,
              e.has_trained_price_knowledge, e.trained_price_low, e.trained_price_high,
              ds.best_discount_percent, ds.discounted_listing_count, ds.discount_bands
     ORDER BY listing_count DESC, p.id ASC
     LIMIT $2 OFFSET $3`,
    [search, limit, offset],
  )

  return (result.rows as Record<string, unknown>[]).map((r) => {
    const secondhand = resolveSecondhandPrice(
      r.used_price_low,
      r.used_price_high,
      r.used_price_source,
      r.has_trained_price_knowledge,
      r.trained_price_low,
      r.trained_price_high,
    )
    return {
      id: r.id as number,
      base_model: r.base_model as string,
      variant_tier: r.variant_tier as string | null,
      listing_count: Number(r.listing_count),
      price_min: toNullableNumber(r.price_min),
      price_max: toNullableNumber(r.price_max),
      price_avg: toNullableNumber(r.price_avg),
      sample_photo_url: r.sample_photo_url as string | null,
      new_price_low: toNullableNumber(r.new_price_low),
      new_price_high: toNullableNumber(r.new_price_high),
      secondhand_price_low: secondhand.low,
      secondhand_price_high: secondhand.high,
      secondhand_price_source: secondhand.source,
      best_discount_percent: toNullableNumber(r.best_discount_percent),
      discounted_listing_count: Number(r.discounted_listing_count ?? 0),
      discount_bands: toDiscountBands(r.discount_bands),
    }
  })
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
  discount_percent: number | null
  reference_price: number | null
}

// percentile_cont(0.5)-equivalent: linear interpolation between the two
// middle values, matching Postgres's median exactly (used server-side in
// getListingDetail's SQL; this JS version is for getProductDetail, which
// already has every sibling listing's price in hand from one query and
// doesn't need a second round trip to compute the same thing).
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = (sorted.length - 1) / 2
  return (sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2
}

function computeMedians(prices: number[]): { rawMedian: number | null; cleanMedian: number | null; sampleSize: number } {
  const rawMedian = median(prices)
  if (rawMedian === null || rawMedian <= 0) return { rawMedian, cleanMedian: null, sampleSize: prices.length }
  const clean = prices.filter((p) => p >= rawMedian / 10 && p <= rawMedian * 10)
  return { rawMedian, cleanMedian: median(clean), sampleSize: prices.length }
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
  new_price_low: number | null
  new_price_high: number | null
  secondhand_price_low: number | null
  secondhand_price_high: number | null
  secondhand_price_source: string | null
  best_discount_percent: number | null
  discounted_listing_count: number
  discount_bands: DiscountBand[]
  enrichment: ProductEnrichment | null
  listings: ProductListingSummary[]
}

export async function getProductDetail(db: QueryClient, productId: number): Promise<ProductDetail | null> {
  const productResult = await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, p.price_lookup_excluded,
            np.price_low as new_price_low, np.price_high as new_price_high,
            up.price_low as used_price_low, up.price_high as used_price_high, up.source as used_price_source,
            e.description as enrichment_description, e.value_drivers as enrichment_value_drivers,
            e.has_trained_price_knowledge as enrichment_has_trained_price_knowledge,
            e.trained_price_low as enrichment_trained_price_low,
            e.trained_price_high as enrichment_trained_price_high,
            e.trained_price_currency as enrichment_trained_price_currency,
            e.model as enrichment_model, e.checked_at as enrichment_checked_at
     FROM products p
     ${NEW_PRICE_LATERAL}
     ${SECONDHAND_PRICE_LATERAL}
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
  const rawListings = (listingsResult.rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    price_amount: toNullableNumber(r.price_amount),
    primary_photo_url: r.primary_photo_url as string | null,
    condition: r.condition as string | null,
    sold_at: toIsoOrNull(r.sold_at),
    price_review: toPriceReview(r),
  }))

  // price_lookup_excluded products (real_estate/too_generic/etc) bundle
  // unrelated real items under one fake "product" - a median across them is
  // meaningless. Forcing an empty price set here makes computeListingDiscount
  // return null for every listing (sampleSize < 2), same effect as
  // DISCOUNT_SUMMARY_LATERAL's exclusion on the products-list page. Confirmed
  // live 2026-08-23: navigating directly to an excluded product's detail page
  // still showed 6 fake discount badges before this fix.
  const validPrices = productRow.price_lookup_excluded
    ? []
    : rawListings.map((l) => l.price_amount).filter((p): p is number => p !== null && p > 0 && !isPlaceholderPrice(p))
  const { rawMedian, cleanMedian, sampleSize } = computeMedians(validPrices)

  const listings = rawListings.map((l) => {
    const discount = computeListingDiscount(l.price_amount, rawMedian, cleanMedian, sampleSize)
    return { ...l, discount_percent: discount.discountPercent, reference_price: discount.referencePrice }
  })

  const discountSummary = summarizeDiscounts(listings.map((l) => l.discount_percent))

  const secondhand = resolveSecondhandPrice(
    productRow.used_price_low,
    productRow.used_price_high,
    productRow.used_price_source,
    productRow.enrichment_has_trained_price_knowledge,
    productRow.enrichment_trained_price_low,
    productRow.enrichment_trained_price_high,
  )

  return {
    id: productRow.id as number,
    base_model: productRow.base_model as string,
    variant_tier: productRow.variant_tier as string | null,
    new_price_low: toNullableNumber(productRow.new_price_low),
    new_price_high: toNullableNumber(productRow.new_price_high),
    secondhand_price_low: secondhand.low,
    secondhand_price_high: secondhand.high,
    secondhand_price_source: secondhand.source,
    best_discount_percent: discountSummary.bestDiscountPercent,
    discounted_listing_count: discountSummary.discountedListingCount,
    discount_bands: discountSummary.bands,
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
  last_seen_at: string | null
  photo_urls: string[]
  product_id: number | null
  base_model: string | null
  variant_tier: string | null
  sold_at: string | null
  price_review: ListingPriceReview | null
  discount_percent: number | null
  reference_price: number | null
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : (value as string)
}

// Same clean-median approach as getProductDetail's in-JS version, but as SQL
// since a single listing's siblings aren't already fetched here - one extra
// round trip, only run when the listing actually has a product_id.
const SIBLING_MEDIAN_SQL = `
  WITH product_prices AS (
    SELECT price_amount FROM listings
    WHERE product_id = $1 AND price_amount IS NOT NULL AND price_amount > 0
      AND ${notPlaceholderPriceSql('price_amount')}
  ),
  raw AS (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_amount) AS median_price, count(*) AS n
    FROM product_prices
  )
  SELECT
    raw.median_price AS raw_median_price,
    raw.n AS sample_size,
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pp.price_amount)
     FROM product_prices pp
     WHERE pp.price_amount BETWEEN raw.median_price / 10 AND raw.median_price * 10) AS clean_median_price
  FROM raw
`

export async function getListingDetail(db: QueryClient, listingId: string): Promise<ListingDetail | null> {
  const result = await db.query(
    `SELECT l.id, l.title, l.price_amount, l.price_currency, l.description, l.condition,
            l.location_city, l.listed_at, l.last_seen_at, l.primary_photo_url, l.stored_photo_urls, l.product_id,
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

  let discount = { discountPercent: null as number | null, referencePrice: null as number | null }
  if (row.product_id !== null && row.product_id !== undefined) {
    const medianResult = await db.query(SIBLING_MEDIAN_SQL, [row.product_id])
    const medianRow = (medianResult.rows as Record<string, unknown>[])[0]
    if (medianRow) {
      discount = computeListingDiscount(
        row.price_amount,
        medianRow.raw_median_price,
        medianRow.clean_median_price,
        medianRow.sample_size,
      )
    }
  }

  return {
    id: row.id as string,
    title: row.title as string,
    price_amount: toNullableNumber(row.price_amount),
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
  }
}
