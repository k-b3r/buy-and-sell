import type { QueryClient } from '../src/platform/storage'
import { resolvePhotoUrls, toIsoOrNull, toNullableNumber } from '../src/platform/rows'
import type { ComparableListing, DiscountBand, ListingPriceReview } from '../src/modules/pricing'
import {
  computeListingDiscount,
  computeMedians,
  DISCOUNT_SUMMARY_LATERAL,
  getComparableListings,
  getPeerMedianPrice,
  getSoldComparablePrice,
  isPlaceholderPrice,
  isPriceInvalidated,
  NEW_PRICE_LATERAL,
  notMagnitudeOutlierSql,
  notPlaceholderPriceSql,
  resolveSecondhandPrice,
  SECONDHAND_PRICE_LATERAL,
  summarizeDiscounts,
  toDiscountBands,
  toPriceReview,
} from '../src/modules/pricing'

export interface ProductSummary {
  id: number
  base_model: string
  variant_tier: string | null
  category: string | null
  sub_category: string | null
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

const DEFAULT_LIMIT = 30

// Must match src/products.ts's PRODUCT_CATEGORIES (the root project's extraction
// enum) - dashboard is a separate package with its own src, no shared import path,
// so this list is duplicated rather than reaching across the package boundary.
const PRODUCT_CATEGORIES = [
  'Phones & Tablets',
  'Computers & Laptops',
  'PC Components',
  'Cameras & Drones',
  'Audio',
  'Gaming',
  'TVs & Monitors',
  'Appliances',
  'Vehicles',
  'Real Estate',
  'Fashion',
  'Fitness & Outdoor',
  'Furniture & Home',
  'Other',
] as const

export async function getProductSummaries(
  db: QueryClient,
  options: { search?: string; categories?: string[]; subCategories?: string[]; offset?: number; limit?: number } = {},
): Promise<ProductSummary[]> {
  const trimmedSearch = options.search?.trim()
  const search = trimmedSearch ? `%${trimmedSearch}%` : null
  const limit = options.limit ?? DEFAULT_LIMIT
  const offset = options.offset ?? 0

  // Category/sub-category filters' placeholders are only appended (and only
  // occupy a param slot) when actually provided - "omit means show every
  // category" needs to stay indistinguishable from "no filter at all",
  // unlike search's always-present-but-nullable $1 pattern, so limit/offset's
  // placeholder numbers shift accordingly.
  const params: unknown[] = [search]
  let categoryClause = ''
  if (options.categories && options.categories.length > 0) {
    params.push(options.categories)
    categoryClause = `AND c.name = ANY($${params.length})`
  }
  let subCategoryClause = ''
  if (options.subCategories && options.subCategories.length > 0) {
    params.push(options.subCategories)
    subCategoryClause = `AND sc.name = ANY($${params.length})`
  }
  const limitPlaceholder = params.length + 1
  const offsetPlaceholder = params.length + 2
  params.push(limit, offset)

  const result = await db.query(
    // The three LATERAL joins below key off p.id alone (per-product, not
    // per-listing) - but with a plain `FROM products p JOIN listings l`,
    // Postgres evaluates them once per LISTING row, not once per product,
    // before GROUP BY collapses back down. For DISCOUNT_SUMMARY_LATERAL in
    // particular (a multi-CTE percentile_cont computation), that meant a
    // product with 20 listings paid its full cost 20x. Confirmed live
    // 2026-08-24 via EXPLAIN ANALYZE: ~2.75s dominated by this lateral
    // running ~6000 times (once per listing) instead of ~3800 (once per
    // product). Pre-aggregating listings per product in a CTE - named `p`
    // so the lateral snippets' existing p.id/p.price_lookup_excluded
    // references keep working unchanged - means each lateral now runs
    // exactly once per product.
    // l.sold_at IS NULL below: sold listings are never deleted (only flagged),
    // so without this the aggregation (count/min/max/avg/photo) stayed
    // influenced by sold-out stock forever. Inner JOIN means a product whose
    // every listing is sold drops out of the CTE entirely - it vanishes from
    // the list rather than showing as a stale/empty card, per direct
    // instruction (2026-08-29): nothing left to buy, don't list it.
    // product_median's raw_median_price is the same pre-outlier-exclusion
    // median DISCOUNT_SUMMARY_LATERAL calls "raw" - used here only to gate
    // price_min/max/avg against magnitude-outlier troll prices (see
    // notMagnitudeOutlierSql), not as a displayed value itself.
    `WITH product_median AS (
       SELECT l.product_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY l.price_amount) AS raw_median_price
       FROM listings l
       WHERE l.sold_at IS NULL AND l.price_amount IS NOT NULL AND l.price_amount > 0
         AND ${notPlaceholderPriceSql('l.price_amount')}
       GROUP BY l.product_id
     ),
     p AS (
       SELECT p.id, p.base_model, p.variant_tier, c.name AS category, sc.name AS sub_category, p.price_lookup_excluded,
              count(l.id) as listing_count,
              min(l.price_amount) FILTER (WHERE l.price_amount > 0 AND ${notPlaceholderPriceSql('l.price_amount')} AND ${notMagnitudeOutlierSql('l.price_amount', 'pm.raw_median_price')}) as price_min,
              max(l.price_amount) FILTER (WHERE l.price_amount > 0 AND ${notPlaceholderPriceSql('l.price_amount')} AND ${notMagnitudeOutlierSql('l.price_amount', 'pm.raw_median_price')}) as price_max,
              avg(l.price_amount) FILTER (WHERE l.price_amount > 0 AND ${notPlaceholderPriceSql('l.price_amount')} AND ${notMagnitudeOutlierSql('l.price_amount', 'pm.raw_median_price')}) as price_avg,
              COALESCE(max(l.stored_photo_urls->>0), max(l.primary_photo_url)) as sample_photo_url
       FROM products p
       JOIN listings l ON l.product_id = p.id
       LEFT JOIN product_median pm ON pm.product_id = p.id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN categories sc ON sc.id = p.sub_category_id
       WHERE l.sold_at IS NULL AND ($1::text IS NULL OR p.base_model ILIKE $1) ${categoryClause} ${subCategoryClause}
       GROUP BY p.id, p.base_model, p.variant_tier, c.name, sc.name, p.price_lookup_excluded
     )
     SELECT p.id, p.base_model, p.variant_tier, p.category, p.sub_category,
            p.listing_count, p.price_min, p.price_max, p.price_avg, p.sample_photo_url,
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
     FROM p
     ${NEW_PRICE_LATERAL}
     ${SECONDHAND_PRICE_LATERAL}
     ${DISCOUNT_SUMMARY_LATERAL}
     LEFT JOIN product_enrichment e ON e.product_id = p.id
     ORDER BY p.listing_count DESC, p.id ASC
     LIMIT $${limitPlaceholder} OFFSET $${offsetPlaceholder}`,
    params,
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
      category: r.category as string | null,
      sub_category: r.sub_category as string | null,
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

export interface SubCategoryTreeEntry {
  subCategory: string
  parentCategory: string
}

// Unlike PRODUCT_CATEGORIES (a fixed 14-way split, safe to hardcode), the
// sub-category leaves are numerous and specific to
// categories.parent_id's seeding - db/schema.sql is the only source of truth
// for which leaf belongs under which of the 14, so this queries it live
// rather than duplicating a third parallel mapping. 'Other' is a UNION'd
// synthetic row: it's a leaf in its own right (products.sub_category_id can
// point straight at it) but has no child row of its own to join through -
// see schema.sql's "sub-categories" migration comment.
export async function getSubCategoryTree(db: QueryClient): Promise<SubCategoryTreeEntry[]> {
  const result = await db.query(
    `SELECT sub.name AS sub_category, parent.name AS parent_category
     FROM categories sub
     JOIN categories parent ON parent.id = sub.parent_id
     WHERE parent.name = ANY($1)
     UNION ALL
     SELECT 'Other', 'Other'`,
    [PRODUCT_CATEGORIES],
  )
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    subCategory: r.sub_category as string,
    parentCategory: r.parent_category as string,
  }))
}

interface ProductReviewEnrichment {
  description: string
  value_drivers: string
  has_trained_price_knowledge: boolean
  trained_price_low: number | null
  trained_price_high: number | null
  trained_price_currency: string | null
  model: string
  checked_at: string
  confidence: string | null
  is_specific_product: boolean | null
}

interface ProductPriceHistoryEntry {
  id: number
  kind: 'new' | 'secondhand'
  price_low: number | null
  price_high: number | null
  price_currency: string | null
  source: string
  condition: string | null
  checked_at: string
}

// Same kind split NEW_PRICE_LATERAL/SECONDHAND_PRICE_LATERAL use to pick the
// current winning row - reused here so a source's history bucket never
// disagrees with which bucket its "current price" came from.
function toPriceHistory(value: unknown): ProductPriceHistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value.map((row) => {
    const r = row as Record<string, unknown>
    return {
      id: Number(r.id),
      kind: (r.kind as string) === 'new' ? 'new' : 'secondhand',
      price_low: toNullableNumber(r.price_low),
      price_high: toNullableNumber(r.price_high),
      price_currency: r.price_currency as string | null,
      source: r.source as string,
      condition: r.condition as string | null,
      checked_at: toIsoOrNull(r.checked_at) as string,
    }
  })
}

export interface ProductNeedingReview {
  id: number
  base_model: string
  variant_tier: string | null
  category: string | null
  sub_category: string | null
  sample_photo_url: string | null
  new_price_low: number | null
  new_price_high: number | null
  secondhand_price_low: number | null
  secondhand_price_high: number | null
  price_history: ProductPriceHistoryEntry[]
  enrichment: ProductReviewEnrichment | null
}

// price_lookup_review_status = 'needs_review' is set by
// applyEligibilityFromEnrichment (src/domains/marketplace/storage/products.ts)
// when Groq's own confidence in identifying the product came back 'low' - see
// db/schema.sql's comment on the column. Never auto-resolves; this is the
// admin review page that comment says doesn't exist yet.
export async function getProductsNeedingReview(db: QueryClient): Promise<ProductNeedingReview[]> {
  const result = await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, c.name AS category, sc.name AS sub_category,
            (SELECT COALESCE(l.stored_photo_urls->>0, l.primary_photo_url)
             FROM listings l WHERE l.product_id = p.id ORDER BY l.id LIMIT 1) AS sample_photo_url,
            np.price_low AS new_price_low, np.price_high AS new_price_high,
            up.price_low AS secondhand_price_low, up.price_high AS secondhand_price_high,
            (SELECT jsonb_agg(jsonb_build_object(
                'id', h.id,
                'kind', CASE WHEN h.source IN ('manual_new_retail', 'gemini_new_retail', 'tavily_new_retail', 'exa_new_retail', 'claude_code_new_retail') THEN 'new' ELSE 'secondhand' END,
                'price_low', h.price_low,
                'price_high', h.price_high,
                'price_currency', h.price_currency,
                'source', h.source,
                'condition', h.condition,
                'checked_at', h.checked_at
              ) ORDER BY h.checked_at DESC)
             FROM product_price_history h WHERE h.product_id = p.id) AS price_history,
            e.description, e.value_drivers, e.has_trained_price_knowledge,
            e.trained_price_low, e.trained_price_high, e.trained_price_currency,
            e.model, e.checked_at, e.confidence, e.is_specific_product
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN categories sc ON sc.id = p.sub_category_id
     LEFT JOIN product_enrichment e ON e.product_id = p.id
     ${NEW_PRICE_LATERAL}
     ${SECONDHAND_PRICE_LATERAL}
     WHERE p.price_lookup_review_status = 'needs_review'
     ORDER BY p.id`,
    [],
  )
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as number,
    base_model: r.base_model as string,
    variant_tier: r.variant_tier as string | null,
    category: r.category as string | null,
    sub_category: r.sub_category as string | null,
    sample_photo_url: r.sample_photo_url as string | null,
    new_price_low: toNullableNumber(r.new_price_low),
    new_price_high: toNullableNumber(r.new_price_high),
    secondhand_price_low: toNullableNumber(r.secondhand_price_low),
    secondhand_price_high: toNullableNumber(r.secondhand_price_high),
    price_history: toPriceHistory(r.price_history),
    enrichment:
      r.checked_at != null
        ? {
            description: r.description as string,
            value_drivers: r.value_drivers as string,
            has_trained_price_knowledge: r.has_trained_price_knowledge as boolean,
            trained_price_low: toNullableNumber(r.trained_price_low),
            trained_price_high: toNullableNumber(r.trained_price_high),
            trained_price_currency: r.trained_price_currency as string | null,
            model: r.model as string,
            checked_at: toIsoOrNull(r.checked_at) as string,
            confidence: r.confidence as string | null,
            is_specific_product: r.is_specific_product as boolean | null,
          }
        : null,
  }))
}

// The only writer that clears price_lookup_review_status - a human looked at
// the product and it's fine as-is, no exclusion needed. Also stamps
// price_lookup_review_dismissed_at so applyEligibilityFromEnrichment (which
// reruns every enrich-products lap) doesn't flip needs_review back on next
// lap - confidence='low' on product_enrichment never changes, so without this
// stamp the same product re-flags forever.
export async function markProductReviewed(db: QueryClient, productId: number): Promise<void> {
  await db.query(
    `UPDATE products SET price_lookup_review_status = NULL, price_lookup_review_dismissed_at = now() WHERE id = $1`,
    [productId],
  )
}

// Alternative resolution to markProductReviewed: a human looked and agrees
// with Groq's low-confidence hunch that this isn't a real priceable product.
// Reuses price_lookup_excluded same as flagPriceLookupExcluded/
// applyEligibilityFromEnrichment's automatic paths (src/domains/marketplace/
// storage/products.ts) - one flag, three possible writers. Clears the review
// flag too since exclusion is itself a resolution, not a pending state.
export async function excludeProductFromReview(db: QueryClient, productId: number, reason: string): Promise<void> {
  await db.query(
    `UPDATE products SET price_lookup_excluded = true, price_lookup_excluded_reason = $1, price_lookup_review_status = NULL WHERE id = $2`,
    [reason, productId],
  )
}

interface ProductListingSummary {
  id: string
  title: string
  price_amount: number | null
  primary_photo_url: string | null
  condition: string | null
  sold_at: string | null
  listed_at: string | null
  price_review: ListingPriceReview | null
  discount_percent: number | null
  reference_price: number | null
  is_saved: boolean
  // The model's own reasoning for why this exact listing cleared the
  // verification gate (discount-verification.ts's VerificationOutcome,
  // 'verified' case) - null for any listing that never got a verified
  // discount_notifications row, not just an unflagged one.
  verification_reasoning: string | null
}

interface ProductEnrichment {
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
  // Run alongside productResult, not after it - listingsResult only needs
  // productId, not anything from the product row, so there's no reason to
  // pay two round trips back-to-back.
  const [productResult, listingsResult] = await Promise.all([
    db.query(
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
    ),
    db.query(
      `SELECT l.id, l.title, l.price_amount, l.primary_photo_url, l.stored_photo_urls, l.condition, l.sold_at, l.listed_at,
              pr.is_negotiable as price_review_is_negotiable,
              pr.price_low as price_review_low, pr.price_high as price_review_high,
              sv.listing_id IS NOT NULL as is_saved,
              dn.verification_reasoning
       FROM listings l
       LEFT JOIN listing_price_review pr ON pr.listing_id = l.id
       LEFT JOIN saved_listings sv ON sv.listing_id = l.id
       LEFT JOIN discount_notifications dn ON dn.listing_id = l.id AND dn.verified_at IS NOT NULL
       WHERE l.product_id = $1
       ORDER BY l.title`,
      [productId],
    ),
  ])
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

  const rawListings = (listingsResult.rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    price_amount: toNullableNumber(r.price_amount),
    primary_photo_url: resolvePhotoUrls(r.stored_photo_urls, r.primary_photo_url)[0] ?? null,
    condition: r.condition as string | null,
    sold_at: toIsoOrNull(r.sold_at),
    listed_at: toIsoOrNull(r.listed_at),
    price_review: toPriceReview(r),
    is_saved: r.is_saved as boolean,
    verification_reasoning: r.verification_reasoning as string | null,
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
    const priceAmount = l.price_amount !== null && isPriceInvalidated(l.price_amount, rawMedian) ? null : l.price_amount
    return {
      ...l,
      price_amount: priceAmount,
      discount_percent: discount.discountPercent,
      reference_price: discount.referencePrice,
    }
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
// exist) makes `target.product_id` NULL, which the `product_id = NULL`
// filter never matches - product_prices comes back empty and every column
// here comes back NULL/0, same "no siblings" shape callers already handle.
const SIBLING_MEDIAN_SQL = `
  WITH target AS (
    SELECT product_id FROM listings WHERE id = $1
  ),
  product_prices AS (
    SELECT price_amount FROM listings
    WHERE product_id = (SELECT product_id FROM target) AND price_amount IS NOT NULL AND price_amount > 0
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
  // (getSoldComparablePrice's n>=3, getPeerMedianPrice's n>=2) is met - same
  // bar /deals uses to call something a real tier, so this page never shows
  // weaker evidence than what would've qualified the listing there.
  const productId = toNullableNumber(row.product_id)
  let recentSales: ComparableListing[] = []
  let similarListings: ComparableListing[] = []
  if (productId !== null) {
    const [soldComp, peerMedian, salesRows, similarRows] = await Promise.all([
      getSoldComparablePrice(db, productId),
      getPeerMedianPrice(db, productId),
      getComparableListings(db, productId, listingId, true),
      getComparableListings(db, productId, listingId, false),
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

export interface CategoryWeeklySoldCounts {
  category: string
  subCategory: string
  totalSold: number
  weeklyCounts: { weekStart: string; count: number; avgPrice: number | null }[]
}

// sold_at is set once, when the scraper detects Facebook reporting a
// listing as sold - it's detection time, not a confirmed sale time (see
// db/schema.sql's comment on the column). Good enough for a volume trend,
// not for a "when did it actually sell" claim.
//
// Weeks are zero-filled in SQL (CROSS JOIN weeks) rather than left as gaps -
// a line chart with missing x-values draws a straight line across the gap,
// silently implying a smooth ramp between two weeks that may be months
// apart. Every category+subCategory shares the same week range (earliest
// sold_at across the whole table through the current week) so the
// small-multiples are visually comparable on one x-axis.
//
// Grouped by both category_id and sub_category_id read directly off each
// product - not reconciled against categories.parent_id (see
// getSubCategoryTree), so a product misclassified with a sub that doesn't
// belong under its main (e.g. main "Other", sub "Smartphones") renders
// exactly as stored. That's a visible data-quality signal, not a bug to
// paper over here.
export async function getSoldCountsBySubCategory(db: QueryClient): Promise<CategoryWeeklySoldCounts[]> {
  const result = await db.query(
    `WITH bounds AS (
       SELECT date_trunc('week', min(sold_at)) AS min_week, date_trunc('week', now()) AS max_week
       FROM listings WHERE sold_at IS NOT NULL
     ),
     weeks AS (
       SELECT generate_series(min_week, max_week, interval '1 week') AS week_start FROM bounds
     ),
     counts AS (
       SELECT c.name AS category, sc.name AS sub_category, date_trunc('week', l.sold_at) AS week_start, count(*) AS n,
              -- Placeholder/joke prices (see isPlaceholderPrice) would otherwise skew a
              -- week's average toward a fake number the same way they'd skew a discount
              -- calculation - excluded here for the same reason.
              avg(l.price_amount) FILTER (
                WHERE l.price_amount IS NOT NULL AND l.price_amount > 0 AND ${notPlaceholderPriceSql('l.price_amount')}
              ) AS avg_price
       FROM listings l
       JOIN products p ON p.id = l.product_id
       JOIN categories c ON c.id = p.category_id
       JOIN categories sc ON sc.id = p.sub_category_id
       WHERE l.sold_at IS NOT NULL
       GROUP BY c.name, sc.name, date_trunc('week', l.sold_at)
     ),
     groups_with_sales AS (
       SELECT category, sub_category, sum(n) AS total_sold FROM counts GROUP BY category, sub_category
     ),
     category_totals AS (
       SELECT category, sum(total_sold) AS category_total FROM groups_with_sales GROUP BY category
     )
     SELECT gws.category, gws.sub_category, gws.total_sold, w.week_start, COALESCE(counts.n, 0) AS count, counts.avg_price
     FROM groups_with_sales gws
     JOIN category_totals ct ON ct.category = gws.category
     CROSS JOIN weeks w
     LEFT JOIN counts ON counts.category = gws.category AND counts.sub_category = gws.sub_category AND counts.week_start = w.week_start
     ORDER BY ct.category_total DESC, gws.category, gws.total_sold DESC, gws.sub_category, w.week_start`,
    [],
  )

  const groups: CategoryWeeklySoldCounts[] = []
  const byGroup = new Map<string, CategoryWeeklySoldCounts>()
  for (const r of result.rows as Record<string, unknown>[]) {
    const category = r.category as string
    const subCategory = r.sub_category as string
    const key = `${category}::${subCategory}`
    let group = byGroup.get(key)
    if (!group) {
      group = { category, subCategory, totalSold: Number(r.total_sold), weeklyCounts: [] }
      byGroup.set(key, group)
      groups.push(group)
    }
    group.weeklyCounts.push({
      weekStart: toIsoOrNull(r.week_start) as string,
      count: Number(r.count),
      avgPrice: toNullableNumber(r.avg_price),
    })
  }
  return groups
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

export interface SettingRow {
  key: string
  value: number
  updatedAt: string
}

// Every operator-tunable worker/discount-policy knob (see
// src/platform/settings.ts's SETTING_DEFAULTS for the full key list) -
// unfiltered, the dashboard Settings page groups these by key prefix itself.
export async function getAllSettings(db: QueryClient): Promise<SettingRow[]> {
  const result = await db.query(`SELECT key, value, updated_at FROM settings ORDER BY key`, [])
  return (result.rows as { key: string; value: number; updated_at: string }[]).map((r) => ({
    key: r.key,
    value: Number(r.value),
    updatedAt: r.updated_at,
  }))
}

// One batched UPDATE ... FROM (VALUES ...) rather than N single-row
// UPDATEs - a Settings-page section save can touch several keys at once,
// and this keeps that one round trip instead of N.
export async function updateSettings(db: QueryClient, updates: { key: string; value: number }[]): Promise<void> {
  if (updates.length === 0) return
  const valuesSql = updates.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}::integer)`).join(', ')
  const params = updates.flatMap((u) => [u.key, u.value])
  await db.query(
    `UPDATE settings SET value = v.value, updated_at = now()
     FROM (VALUES ${valuesSql}) AS v(key, value)
     WHERE settings.key = v.key`,
    params,
  )
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
