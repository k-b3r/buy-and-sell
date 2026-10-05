import type { QueryClient } from '../../platform/storage'
import { resolvePhotoUrls, toIsoOrNull, toNullableNumber } from '../../platform/rows'
import type { DiscountBand, ListingPriceReview } from '../pricing'
import {
  computeListingDiscount,
  computeMedians,
  DISCOUNT_SUMMARY_LATERAL,
  isPlaceholderPrice,
  isPriceInvalidated,
  medianCtes,
  NEW_PRICE_LATERAL,
  notMagnitudeOutlierSql,
  notPlaceholderPriceSql,
  resolveSecondhandPrice,
  SECONDHAND_PRICE_LATERAL,
  summarizeDiscounts,
  toDiscountBands,
  toPriceReview,
} from '../pricing'

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
    `WITH ${medianCtes({
      name: 'product_median',
      pool: 'SELECT l.product_id, l.price_amount FROM listings l WHERE l.sold_at IS NULL',
      clean: false,
    })},
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
