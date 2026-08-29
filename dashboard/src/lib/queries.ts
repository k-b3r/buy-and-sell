export interface QueryClient {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>
}

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

// Must match src/products.ts's PRODUCT_CATEGORIES (the root project's extraction
// enum) - dashboard is a separate package with its own src, no shared import path,
// so this list is duplicated rather than reaching across the package boundary.
export const PRODUCT_CATEGORIES = [
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

// exa_new_retail is the only source that has ever targeted brand-new retail
// pricing - gemini_grounding and web_search both explicitly ask for
// secondhand/used pricing (see src/pricing.ts's prompt), and Exa itself
// can't reach secondhand listings at all (FB/Carousell aren't indexed,
// confirmed live 2026-08-22 - see CONTEXT.md). Blending these into one
// "market price" number was a real bug: a product's new-retail price would
// silently make every real secondhand listing look like a huge deal against
// full retail. Kept as two separate laterals so the two concepts can never
// collapse into one column again.
// claude_code_new_retail: Claude Code doing a manual WebSearch lookup as a
// stopgap while the paid Exa/free Gemini quota is unavailable (2026-08-28) -
// same "new retail" concept, different mechanism, so it belongs in the same
// lateral rather than a third parallel column. Ordered after exa_new_retail
// (ASC on the boolean puts exa_new_retail - false - first) since Exa is the
// paid, purpose-built source; Claude's ad-hoc web search is the fallback.
const NEW_PRICE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT price_low, price_high, source
    FROM product_price_history h
    WHERE h.product_id = p.id AND h.source IN ('exa_new_retail', 'claude_code_new_retail')
    ORDER BY (h.source = 'claude_code_new_retail') ASC, h.checked_at DESC
    LIMIT 1
  ) np ON true
`

// gemini_grounding/web_search are external secondhand-grounded searches,
// preferred over listing_prices, which is computed from this same
// marketplace's own listings and so is a more circular comparison (see
// db/schema.sql's product_price_history comment).
// claude_code_secondhand: same stopgap reasoning as claude_code_new_retail
// above - ordered last (after listing_prices) since it's the least-grounded
// source here (a manual web search Claude did, not a dedicated pricing
// API), only preferred over having no secondhand price at all.
const SECONDHAND_PRICE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT price_low, price_high, source
    FROM product_price_history h
    WHERE h.product_id = p.id AND h.source IN ('gemini_grounding', 'web_search', 'listing_prices', 'claude_code_secondhand')
    ORDER BY (h.source = 'claude_code_secondhand') ASC, (h.source = 'listing_prices') ASC, h.checked_at DESC
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
      OR trunc(${column})::text ~ '012|123|234|345|456|567|678|789'
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
// placeholders - ascending-sequential digit runs anywhere in the price (123,
// 12345, but also embedded runs like the 456 inside 12456 - confirmed live
// 2026-08-23 against a real ₱12,456 listing that the old start-only-at-1
// prefix check missed), repeated-digit runs (111, 9999), and repeated
// multi-digit blocks (6969, 696969 - joke/meme numbers). Distinct from
// magnitude-outlier detection: found live 2026-08-23 that ₱123,456 fell well
// within the 10x magnitude threshold of a real ₱150,000 median yet is
// obviously not a real ask (it produced a nonsensical -626% "discount").
// Deliberately accepts some false-positive risk on the ascending-run check
// (e.g. a genuine ₱3,456 gets caught too) in exchange for catching embedded
// runs like 12456 - a direct tradeoff picked over the narrower whole-price-
// only version. Minimum length 3 for the same reason as before (₱11, ₱99 are
// plausible real small-item prices).
const ASCENDING_RUN_RE = /012|123|234|345|456|567|678|789/

export function isPlaceholderPrice(price: number): boolean {
  const digits = String(Math.trunc(Math.abs(price)))
  if (digits.length < 3) return false
  if (/^(\d+)\1+$/.test(digits)) return true
  return ASCENDING_RUN_RE.test(digits)
}

// Same magnitude-outlier heuristic as domains/marketplace/storage/listings.ts's getPriceReviewCandidates
// (>10x or <0.1x the raw median) - exactly the pre-filter that makes a
// listing an enrich-listing-prices candidate, independent of whether that
// worker has actually reviewed it yet. Used two ways: computeListingDiscount
// below excludes it from discount/reference-price analysis, and callers
// (getProductDetail/getListingDetail) also null out the listing's own
// price_amount entirely - a mathematically-outlier price isn't shown, not
// just unscored, since a >10x-median number is almost always a placeholder/
// scam/typo, not a real ask worth displaying at all.
export function isMagnitudeOutlier(price: number, rawMedianPrice: number | null): boolean {
  if (rawMedianPrice === null || rawMedianPrice <= 0) return false
  return price < rawMedianPrice / 10 || price > rawMedianPrice * 10
}

// Matches enrich-listing-prices.ts's full candidate criteria (src/db.ts's
// getPriceReviewCandidates): magnitude outlier OR a placeholder digit
// pattern, independent of magnitude (e.g. "123"/"999" can sit well within
// 10x of a real median and still not be a real ask). Either condition means
// the price gets hidden entirely, not just excluded from discount scoring.
export function isPriceInvalidated(price: number, rawMedianPrice: number | null): boolean {
  return isMagnitudeOutlier(price, rawMedianPrice) || isPlaceholderPrice(price)
}

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
  if (isMagnitudeOutlier(price, rawMedian)) return NONE
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
    `WITH p AS (
       SELECT p.id, p.base_model, p.variant_tier, c.name AS category, sc.name AS sub_category, p.price_lookup_excluded,
              count(l.id) as listing_count,
              min(l.price_amount) FILTER (WHERE ${notPlaceholderPriceSql('l.price_amount')}) as price_min,
              max(l.price_amount) FILTER (WHERE ${notPlaceholderPriceSql('l.price_amount')}) as price_max,
              avg(l.price_amount) FILTER (WHERE ${notPlaceholderPriceSql('l.price_amount')}) as price_avg,
              COALESCE(max(l.stored_photo_urls->>0), max(l.primary_photo_url)) as sample_photo_url
       FROM products p
       JOIN listings l ON l.product_id = p.id
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

// Unlike PRODUCT_CATEGORIES/CATEGORY_GROUPS (fixed 14/7-way splits, safe to
// hardcode), the sub-category leaves are numerous and specific to
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
  listed_at: string | null
  price_review: ListingPriceReview | null
  discount_percent: number | null
  reference_price: number | null
  is_saved: boolean
}

// Three independent sources of "don't trust this as a firm price": the LLM
// review (magnitude-outlier prices Groq actually read and judged negotiable),
// the placeholder-pattern check (never sent to an LLM at all - the pattern
// alone is confident enough on its own), and - deliberately broad - simply
// having no discount/overvalue signal to show at all (discountPercent null or
// 0, the exact condition under which DiscountBadge renders nothing). That
// last one means every listing ends up showing at least one pricing-status
// badge instead of silently showing neither.
export function isListingPriceNegotiable(
  priceAmount: number | null,
  priceReview: ListingPriceReview | null,
  discountPercent: number | null,
): boolean {
  if (priceReview?.is_negotiable) return true
  if (priceAmount !== null && isPlaceholderPrice(priceAmount)) return true
  return discountPercent === null || discountPercent === 0
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

// primary_photo_url is Facebook's own CDN link, which expires/requires a
// live FB session - confirmed live 2026-08-23 against real Sony WH-1000XM6
// listings (broken thumbnail on the product's listing cards, but fine on the
// single listing page) because only getListingDetail's query preferred
// stored_photo_urls (the durable R2-hosted copy); getProductDetail's listing
// query didn't select it at all. Single source of truth for both now.
function resolvePhotoUrls(storedPhotoUrls: unknown, primaryPhotoUrl: unknown): string[] {
  const stored = storedPhotoUrls as string[] | null
  if (stored && stored.length > 0) return stored
  return primaryPhotoUrl ? [primaryPhotoUrl as string] : []
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
              sv.listing_id IS NOT NULL as is_saved
       FROM listings l
       LEFT JOIN listing_price_review pr ON pr.listing_id = l.id
       LEFT JOIN saved_listings sv ON sv.listing_id = l.id
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
    return { ...l, price_amount: priceAmount, discount_percent: discount.discountPercent, reference_price: discount.referencePrice }
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
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : (value as string)
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
              sv.listing_id IS NOT NULL as is_saved
       FROM listings l
       LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN listing_price_review pr ON pr.listing_id = l.id
       LEFT JOIN saved_listings sv ON sv.listing_id = l.id
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
    ? computeListingDiscount(row.price_amount, medianRow.raw_median_price, medianRow.clean_median_price, medianRow.sample_size)
    : { discountPercent: null, referencePrice: null }

  const priceAmount = toNullableNumber(row.price_amount)

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
// apart. Every category shares the same week range (earliest sold_at across
// the whole table through the current week) so the small-multiples are
// visually comparable on one x-axis.
export async function getSoldCountsByCategory(db: QueryClient): Promise<CategoryWeeklySoldCounts[]> {
  const result = await db.query(
    `WITH bounds AS (
       SELECT date_trunc('week', min(sold_at)) AS min_week, date_trunc('week', now()) AS max_week
       FROM listings WHERE sold_at IS NOT NULL
     ),
     weeks AS (
       SELECT generate_series(min_week, max_week, interval '1 week') AS week_start FROM bounds
     ),
     counts AS (
       SELECT c.name AS category, date_trunc('week', l.sold_at) AS week_start, count(*) AS n,
              -- Placeholder/joke prices (see isPlaceholderPrice) would otherwise skew a
              -- week's average toward a fake number the same way they'd skew a discount
              -- calculation - excluded here for the same reason.
              avg(l.price_amount) FILTER (
                WHERE l.price_amount IS NOT NULL AND l.price_amount > 0 AND ${notPlaceholderPriceSql('l.price_amount')}
              ) AS avg_price
       FROM listings l
       JOIN products p ON p.id = l.product_id
       JOIN categories c ON c.id = p.category_id
       WHERE l.sold_at IS NOT NULL
       GROUP BY c.name, date_trunc('week', l.sold_at)
     ),
     categories_with_sales AS (
       SELECT category, sum(n) AS total_sold FROM counts GROUP BY category
     )
     SELECT cws.category, cws.total_sold, w.week_start, COALESCE(counts.n, 0) AS count, counts.avg_price
     FROM categories_with_sales cws
     CROSS JOIN weeks w
     LEFT JOIN counts ON counts.category = cws.category AND counts.week_start = w.week_start
     ORDER BY cws.total_sold DESC, cws.category, w.week_start`,
    [],
  )

  const groups: CategoryWeeklySoldCounts[] = []
  const byCategory = new Map<string, CategoryWeeklySoldCounts>()
  for (const r of result.rows as Record<string, unknown>[]) {
    const category = r.category as string
    let group = byCategory.get(category)
    if (!group) {
      group = { category, totalSold: Number(r.total_sold), weeklyCounts: [] }
      byCategory.set(category, group)
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
