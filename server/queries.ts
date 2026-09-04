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

// price-lookup.ts's retail chain, in preference order: gemini_new_retail
// (primary, free - promoted 2026-09-02 since a free Gemini attempt can only
// ever save a paid Exa/Tavily call, never add cost) -> exa_new_retail
// (fallback 1, structured, cites sources) -> tavily_new_retail (fallback 2,
// free, regex-parsed) - see src/domains/marketplace/price-lookup.ts. Only
// one of these is ever written per product per lookup (whichever
// succeeded), so in practice they don't compete against each other here,
// but the ordering still reflects real trust tier if historical data ever
// overlaps. claude_code_new_retail is retired (kept so historical rows
// still resolve). gemini_grounding and web_search both explicitly ask for
// secondhand/used pricing instead (see price-lookup.ts's prompts). Blending
// new/secondhand into one "market price" number was a real bug: a
// product's new-retail price would silently make every real secondhand
// listing look like a huge deal against full retail. Kept as two separate
// laterals so the two concepts can never collapse into one column again.
// manual_new_retail: a human directly typed this in on the needs-review page
// (setManualPrice) - ranked above every automated source since a human
// already looked at the specific product, not a generic search result.
// Outranks even a later automated run: once a human has vetted the price,
// nothing here re-promotes an automated guess back over it.
const NEW_PRICE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT price_low, price_high, source
    FROM product_price_history h
    WHERE h.product_id = p.id AND h.source IN ('manual_new_retail', 'gemini_new_retail', 'tavily_new_retail', 'exa_new_retail', 'claude_code_new_retail')
    ORDER BY (h.source = 'manual_new_retail') DESC, (h.source = 'claude_code_new_retail') ASC, h.checked_at DESC
    LIMIT 1
  ) np ON true
`

// price-lookup.ts's secondhand chain, in preference order: gemini_grounding
// (primary, free - won a live accuracy comparison against Exa on secondhand
// specifically, 2026-08-31) -> exa_secondhand (fallback 1, structured, cites
// sources) -> tavily_secondhand (fallback 2, free, regex-parsed) - only one
// of these is ever written per product per lookup (whichever succeeded), so
// in practice they don't compete against each other here, but the ordering
// still reflects real trust tier if historical data ever overlaps.
// web_search is retired (Claude's old combined retail+secondhand call, kept
// so historical rows still resolve). listing_prices is computed from this
// same marketplace's own listings, a more circular comparison (see
// db/schema.sql's product_price_history comment), so it's deprioritized
// below every external search source.
// claude_code_secondhand: same stopgap reasoning as claude_code_new_retail
// above - ordered last (after listing_prices) since it's the least-grounded
// source here (a manual web search Claude did, not a dedicated pricing
// API), only preferred over having no secondhand price at all.
// manual_secondhand: same reasoning as manual_new_retail above - a human's
// own entry on the needs-review page outranks every automated secondhand
// source, including this marketplace's own listing_prices.
const SECONDHAND_PRICE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT price_low, price_high, source
    FROM product_price_history h
    WHERE h.product_id = p.id AND h.source IN
      ('manual_secondhand', 'gemini_grounding', 'exa_secondhand', 'tavily_secondhand', 'web_search', 'listing_prices', 'claude_code_secondhand')
    ORDER BY (h.source = 'manual_secondhand') DESC, (h.source = 'claude_code_secondhand') ASC, (h.source = 'listing_prices') ASC, h.checked_at DESC
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

// SQL equivalent of isMagnitudeOutlier below - same >10x/<0.1x-of-median
// heuristic, single source of truth for the price_min/max/avg aggregate
// (notPlaceholderPriceSql alone requires >=3 digits, so a troll ₱2 or a
// troll ₱123456789 that doesn't happen to hit a digit-pattern isn't caught
// by it - confirmed live 2026-09-02: home/product-list page showed price
// ranges like ₱2-₱123,456,789).
function notMagnitudeOutlierSql(column: string, medianColumn: string): string {
  return `(${medianColumn} IS NULL OR ${medianColumn} <= 0 OR ${column} BETWEEN ${medianColumn} / 10 AND ${medianColumn} * 10)`
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

export interface ProductReviewEnrichment {
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

export interface ProductPriceHistoryEntry {
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
  // The model's own reasoning for why this exact listing cleared the
  // verification gate (discount-verification.ts's VerificationOutcome,
  // 'verified' case) - null for any listing that never got a verified
  // discount_notifications row, not just an unflagged one.
  verification_reasoning: string | null
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
  verification_reasoning: string | null
  recent_sales: ComparableListing[]
  similar_listings: ComparableListing[]
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
    ? computeListingDiscount(row.price_amount, medianRow.raw_median_price, medianRow.clean_median_price, medianRow.sample_size)
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

export interface SoldComparablePrice {
  medianPrice: number
  sampleSize: number
}

// Three or more independent sales before treating the median as a real
// signal rather than noise - one lucky/unlucky sold listing shouldn't
// anchor a reference price. Also the "sold_comps" confidence tier's bar for
// the deals page (highest tier; falls back to peer active-listing median,
// then an LLM estimate, when this returns null - see [deals page] once built).
const SOLD_COMP_MIN_SAMPLE = 3

// Same clean-median approach as SIBLING_MEDIAN_SQL/DISCOUNT_SUMMARY_LATERAL
// above, but scoped to listings Facebook has actually marked sold
// (sold_at IS NOT NULL) instead of current asking prices - a real
// transacted-market signal, not just what someone's currently hoping to get.
// Facebook doesn't expose the actual agreed sale price logged-out, so this
// is "what it was asking when it sold," not a true transaction price -
// still materially better than an active listing's ask, which nobody has
// paid yet.
const SOLD_COMP_MEDIAN_SQL = `
  WITH product_prices AS (
    SELECT pl.price_amount FROM listings pl
    JOIN products p ON p.id = pl.product_id
    WHERE pl.product_id = $1 AND pl.sold_at IS NOT NULL
      AND pl.price_amount IS NOT NULL AND pl.price_amount > 0
      AND NOT p.price_lookup_excluded
      AND ${notPlaceholderPriceSql('pl.price_amount')}
  ),
  raw AS (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_amount) AS median_price, count(*) AS n
    FROM product_prices
  )
  SELECT
    raw.n AS sample_size,
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pp.price_amount)
     FROM product_prices pp, raw
     WHERE raw.n >= ${SOLD_COMP_MIN_SAMPLE} AND raw.median_price > 0
       AND pp.price_amount BETWEEN raw.median_price / 10 AND raw.median_price * 10) AS clean_median_price
  FROM raw
`

export async function getSoldComparablePrice(db: QueryClient, productId: number): Promise<SoldComparablePrice | null> {
  const result = await db.query(SOLD_COMP_MEDIAN_SQL, [productId])
  const row = (result.rows as Record<string, unknown>[])[0]
  if (!row) return null

  const sampleSize = Number(row.sample_size)
  const medianPrice = toNullableNumber(row.clean_median_price)
  if (sampleSize < SOLD_COMP_MIN_SAMPLE || medianPrice === null || medianPrice <= 0) return null

  return { medianPrice, sampleSize }
}

export interface PeerMedianPrice {
  medianPrice: number
  sampleSize: number
}

// Deals page's second-tier reference price: median of *active* (still-listed,
// nobody's paid yet) peer listings of the same product, used when
// getSoldComparablePrice above has too few actual sales to trust. Two
// listings is enough here (vs SOLD_COMP_MIN_SAMPLE's 3) since this is already
// the fallback tier - demanding the same bar as sold comps would just push
// more products down to the even-less-precise LLM-estimate tier.
const PEER_MEDIAN_MIN_SAMPLE = 2

// Same clean-median/placeholder-price approach as SOLD_COMP_MEDIAN_SQL, but
// scoped to active listings (sold_at IS NULL) instead of sold ones - "what
// competing sellers are asking right now" rather than "what last actually
// sold". Per-product (unlike SIBLING_MEDIAN_SQL, which takes a listing id and
// looks up its product) so the deals page can call this once per product
// instead of once per listing.
const PEER_MEDIAN_SQL = `
  WITH product_prices AS (
    SELECT pl.price_amount FROM listings pl
    JOIN products p ON p.id = pl.product_id
    WHERE pl.product_id = $1 AND pl.sold_at IS NULL
      AND pl.price_amount IS NOT NULL AND pl.price_amount > 0
      AND NOT p.price_lookup_excluded
      AND ${notPlaceholderPriceSql('pl.price_amount')}
  ),
  raw AS (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_amount) AS median_price, count(*) AS n
    FROM product_prices
  )
  SELECT
    raw.n AS sample_size,
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pp.price_amount)
     FROM product_prices pp, raw
     WHERE raw.n >= ${PEER_MEDIAN_MIN_SAMPLE} AND raw.median_price > 0
       AND pp.price_amount BETWEEN raw.median_price / 10 AND raw.median_price * 10) AS clean_median_price
  FROM raw
`

export async function getPeerMedianPrice(db: QueryClient, productId: number): Promise<PeerMedianPrice | null> {
  const result = await db.query(PEER_MEDIAN_SQL, [productId])
  const row = (result.rows as Record<string, unknown>[])[0]
  if (!row) return null

  const sampleSize = Number(row.sample_size)
  const medianPrice = toNullableNumber(row.clean_median_price)
  if (sampleSize < PEER_MEDIAN_MIN_SAMPLE || medianPrice === null || medianPrice <= 0) return null

  return { medianPrice, sampleSize }
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
    `WITH product_prices AS (
       SELECT pl.id, pl.title, pl.price_amount, pl.primary_photo_url, pl.stored_photo_urls, ${dateColumn} AS date
       FROM listings pl
       JOIN products p ON p.id = pl.product_id
       WHERE pl.product_id = $1 AND pl.id != $2 AND ${soldClause}
         AND pl.price_amount IS NOT NULL AND pl.price_amount > 0
         AND NOT p.price_lookup_excluded
         AND ${notPlaceholderPriceSql('pl.price_amount')}
     ),
     raw AS (
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_amount) AS median_price
       FROM product_prices
     )
     SELECT pp.id AS listing_id, pp.title, pp.price_amount, pp.primary_photo_url, pp.stored_photo_urls, pp.date
     FROM product_prices pp, raw
     WHERE raw.median_price > 0 AND pp.price_amount BETWEEN raw.median_price / 10 AND raw.median_price * 10
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

export type DealsConfidenceTier = 'sold_comps' | 'peer_listings' | 'llm_estimate'

const CONFIDENCE_TIER_RANK: Record<DealsConfidenceTier, number> = {
  sold_comps: 3,
  peer_listings: 2,
  llm_estimate: 1,
}

// Same ranking baked into SQL as TIER_RANK_SQL below - kept in one place so
// a minConfidenceTier filter and the tier's own displayed rank can't drift.
const TIER_RANK_SQL = `CASE tier WHEN 'sold_comps' THEN 3 WHEN 'peer_listings' THEN 2 WHEN 'llm_estimate' THEN 1 ELSE 0 END`

export interface DealListing {
  listing_id: string
  title: string
  ask_price: number
  photo_url: string | null
  product_id: number | null
  base_model: string | null
  variant_tier: string | null
  category: string | null
  sub_category: string | null
  reference_price: number | null
  tier: DealsConfidenceTier | null
  // Count of comparable listings behind the winning tier - sold listings for
  // sold_comps, active peer listings for peer_listings, null for
  // llm_estimate (nothing to count) or no tier at all.
  comp_count: number | null
  profit_pesos: number | null
  discount_percent: number | null
  days_listed: number | null
  is_saved: boolean
  is_low_confidence: boolean
}

export interface DealsDiscountPolicyFloors {
  minProfitPesos: number
  minPricePesos: number
}

export interface DealsFilters {
  search?: string
  categories?: string[]
  minProfitPesos?: number
  minConfidenceTier?: DealsConfidenceTier
  maxDaysListed?: number
  soldOnly?: boolean
  lowConfidenceOnly?: boolean
  offset?: number
  limit?: number
}

const DEALS_DEFAULT_LIMIT = 30
// Confirmed live 2026-09-03: phones dominate the ranked list because they
// both (a) dedupe cleanly into one product across many sellers, reaching the
// sold_comps/peer_listings tiers far more often than one-off items (~75% of
// all products are singleton-listing per SESSION_RESUME.md), and (b) produce
// bigger absolute profit_pesos at their price point even at the same
// discount %, and profit_pesos - not a normalized rate - is the tie-breaker
// within a tier. No per-category cap meant a strong category could fill
// every slot on the page. Applied to the main ranked list only, not the
// low-confidence bucket (see lowConfidenceOnly below).
const DEALS_CATEGORY_CAP = 10

// /deals page's ranked-by-profit view of active listings. One row per
// listing (not per product like getProductSummaries) - a product with 5
// active listings is 5 separate buy-and-sell opportunities, each with its
// own ask price.
//
// Reference-price fallback chain, highest confidence first (see
// getSoldComparablePrice/getPeerMedianPrice above for the same clean-median
// approach applied per-tier): sold comps (n>=3 actual sales) -> active peer
// listings (n>=2) -> LLM estimate (used_price_low/high, falling back to
// enrichment's trained_price_low/high the same way resolveSecondhandPrice
// does elsewhere in this file, collapsed to a single point estimate via
// midpoint since the deals page ranks by one number, not a range).
// Everything computed in one SQL pass (not fetched raw then filtered/sorted
// in JS) so profit-based filtering, tier-rank filtering, and ORDER BY/LIMIT
// all operate on the real ranking key instead of an unfiltered page of raw
// listings that then shrinks unpredictably after JS-side filtering.
//
// "Low confidence" bucket (per SESSION_RESUME.md's spec): an llm_estimate-
// tier row whose product has at most 1 active priced peer listing (i.e. this
// listing IS that product's only current listing - a singleton, per the
// "Done" section's ~75%-singleton finding) is too thin a guess to rank
// alongside real comps. lowConfidenceOnly toggles between the main ranked
// list (excludes these + tier-less rows) and this bucket (only these).
export async function getDeals(
  db: QueryClient,
  discountPolicy: DealsDiscountPolicyFloors,
  filters: DealsFilters = {},
): Promise<DealListing[]> {
  const params: unknown[] = []
  const push = (value: unknown): string => {
    params.push(value)
    return `$${params.length}`
  }

  const soldClause = filters.soldOnly ? 'l.sold_at IS NOT NULL' : 'l.sold_at IS NULL'

  // Policy floor is a hard minimum, not just a default - a filter asking for
  // less than the floor doesn't get to punch through it (see "Decided" in
  // SESSION_RESUME.md: min_profit_pesos/min_price_pesos are operator-tunable
  // policy, not something this page's UI should be able to undercut).
  const minProfitPesos = Math.max(discountPolicy.minProfitPesos, filters.minProfitPesos ?? 0)
  const minProfitPlaceholder = push(minProfitPesos)
  const minPricePlaceholder = push(discountPolicy.minPricePesos)
  const minTierRank = filters.minConfidenceTier ? CONFIDENCE_TIER_RANK[filters.minConfidenceTier] : 0
  const minTierPlaceholder = push(minTierRank)
  const lowConfidenceOnlyPlaceholder = push(!!filters.lowConfidenceOnly)

  let categoryClause = ''
  if (filters.categories && filters.categories.length > 0) {
    categoryClause = `AND category = ANY(${push(filters.categories)})`
  }
  let daysListedClause = ''
  if (filters.maxDaysListed !== undefined) {
    daysListedClause = `AND days_listed IS NOT NULL AND days_listed <= ${push(filters.maxDaysListed)}`
  }
  // Against title and base_model - a listing's title is what's actually
  // shown on the row (and what a search term is most likely echoing back),
  // base_model as a fallback for titles that don't spell the product name
  // out plainly (e.g. a title that's just "RUSH SALE!!! 🔥🔥🔥").
  let searchClause = ''
  const trimmedSearch = filters.search?.trim()
  if (trimmedSearch) {
    const searchPlaceholder = push(`%${trimmedSearch}%`)
    searchClause = `AND (title ILIKE ${searchPlaceholder} OR base_model ILIKE ${searchPlaceholder})`
  }

  const limit = filters.limit ?? DEALS_DEFAULT_LIMIT
  const offset = filters.offset ?? 0
  const limitPlaceholder = push(limit)
  const offsetPlaceholder = push(offset)
  const categoryCapPlaceholder = push(DEALS_CATEGORY_CAP)

  const result = await db.query(
    `WITH sold_product_prices AS (
       SELECT pl.product_id, pl.price_amount FROM listings pl
       JOIN products prod ON prod.id = pl.product_id
       WHERE pl.sold_at IS NOT NULL AND pl.price_amount IS NOT NULL AND pl.price_amount > 0
         AND NOT prod.price_lookup_excluded AND ${notPlaceholderPriceSql('pl.price_amount')}
     ),
     sold_raw AS (
       SELECT product_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_amount) AS median_price, count(*) AS n
       FROM sold_product_prices GROUP BY product_id
     ),
     sold_comp AS (
       SELECT sold_raw.product_id, sold_raw.n AS sample_size, clean.median_price AS clean_median_price
       FROM sold_raw
       LEFT JOIN LATERAL (
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pp.price_amount) AS median_price
         FROM sold_product_prices pp
         WHERE pp.product_id = sold_raw.product_id AND sold_raw.n >= ${SOLD_COMP_MIN_SAMPLE} AND sold_raw.median_price > 0
           AND pp.price_amount BETWEEN sold_raw.median_price / 10 AND sold_raw.median_price * 10
       ) clean ON true
     ),
     peer_product_prices AS (
       SELECT pl.product_id, pl.price_amount FROM listings pl
       JOIN products prod ON prod.id = pl.product_id
       WHERE pl.sold_at IS NULL AND pl.price_amount IS NOT NULL AND pl.price_amount > 0
         AND NOT prod.price_lookup_excluded AND ${notPlaceholderPriceSql('pl.price_amount')}
     ),
     peer_raw AS (
       SELECT product_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_amount) AS median_price, count(*) AS n
       FROM peer_product_prices GROUP BY product_id
     ),
     peer_median AS (
       SELECT peer_raw.product_id, peer_raw.n AS sample_size, clean.median_price AS clean_median_price
       FROM peer_raw
       LEFT JOIN LATERAL (
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pp.price_amount) AS median_price
         FROM peer_product_prices pp
         WHERE pp.product_id = peer_raw.product_id AND peer_raw.n >= ${PEER_MEDIAN_MIN_SAMPLE} AND peer_raw.median_price > 0
           AND pp.price_amount BETWEEN peer_raw.median_price / 10 AND peer_raw.median_price * 10
       ) clean ON true
     ),
     -- Deduped to one row per product with at least one active listing (not
     -- one LATERAL invocation per listing) - same "evaluate once per
     -- product" fix getProductSummaries' comment documents learning the
     -- hard way (2026-08-24 EXPLAIN ANALYZE).
     --
     -- price_lookup_excluded gated here too, not just in sold_comp/peer_median
     -- above - without it, an excluded product's llm_estimate still slipped
     -- through (product_enrichment/product_price_history aren't gated on the
     -- flag either). Confirmed live 2026-09-02: two different "House & Lot"
     -- listings (price_lookup_excluded=true, real estate never got real
     -- price-lookup treatment) shared the same nonsense trained-price
     -- estimate and showed as ₱200M+ "deals" in the low-confidence bucket.
     p AS (
       SELECT DISTINCT l.product_id AS id FROM listings l
       JOIN products prod ON prod.id = l.product_id
       WHERE l.product_id IS NOT NULL AND (${soldClause}) AND l.flagged_removed_at IS NULL
         AND NOT prod.price_lookup_excluded
     ),
     llm_estimate AS (
       SELECT p.id AS product_id, up.price_low AS used_price_low, up.price_high AS used_price_high,
              e.has_trained_price_knowledge, e.trained_price_low, e.trained_price_high
       FROM p
       ${SECONDHAND_PRICE_LATERAL}
       LEFT JOIN product_enrichment e ON e.product_id = p.id
     ),
     deal AS (
       SELECT
         l.id AS listing_id, l.title,
         -- Prefer the price review's read over the raw recorded number when
         -- one exists - listing_price_review.price_amount is never written
         -- to (db/schema.sql), so a data error (dropped digit, placeholder)
         -- survives here otherwise. price_high (not price_low) so a bundle
         -- range doesn't understate what you'd actually pay and inflate
         -- profit_pesos. Confirmed live 2026-09-02: an iPhone 16 recorded at
         -- ₱3,900 (real ask ₱39,000 per its description) ranked as an
         -- ₱29,850-profit "deal" - within the 10x-of-reference guard below
         -- on the raw number alone.
         COALESCE(pr.price_high, pr.price_low, l.price_amount) AS ask_price,
         l.listed_at,
         l.primary_photo_url, l.stored_photo_urls, l.product_id,
         prod.base_model, prod.variant_tier, cat.name AS category, subcat.name AS sub_category,
         sv.listing_id IS NOT NULL AS is_saved,
         pm.sample_size AS peer_sample_size,
         COALESCE(
           sc.clean_median_price,
           pm.clean_median_price,
           CASE
             WHEN le.used_price_low IS NOT NULL THEN (le.used_price_low + le.used_price_high) / 2.0
             WHEN le.has_trained_price_knowledge THEN (le.trained_price_low + le.trained_price_high) / 2.0
             ELSE NULL
           END
         ) AS reference_price,
         CASE
           WHEN sc.clean_median_price IS NOT NULL THEN 'sold_comps'
           WHEN pm.clean_median_price IS NOT NULL THEN 'peer_listings'
           WHEN le.used_price_low IS NOT NULL OR le.has_trained_price_knowledge THEN 'llm_estimate'
           ELSE NULL
         END AS tier,
         -- Same branch as tier above (kept as its own CASE, not a lookup off
         -- tier, since tier isn't computed yet at this point in the SELECT).
         CASE
           WHEN sc.clean_median_price IS NOT NULL THEN sc.sample_size
           WHEN pm.clean_median_price IS NOT NULL THEN pm.sample_size
           ELSE NULL
         END AS comp_count,
         EXTRACT(EPOCH FROM (now() - l.listed_at)) / 86400 AS days_listed
       FROM listings l
       JOIN products prod ON prod.id = l.product_id
       LEFT JOIN categories cat ON cat.id = prod.category_id
       LEFT JOIN categories subcat ON subcat.id = prod.sub_category_id
       LEFT JOIN saved_listings sv ON sv.listing_id = l.id
       LEFT JOIN sold_comp sc ON sc.product_id = prod.id
       LEFT JOIN peer_median pm ON pm.product_id = prod.id
       LEFT JOIN llm_estimate le ON le.product_id = prod.id
       LEFT JOIN listing_price_review pr ON pr.listing_id = l.id
       WHERE ${soldClause} AND l.flagged_removed_at IS NULL
         AND l.price_amount IS NOT NULL AND l.price_amount > 0
         AND ${notPlaceholderPriceSql('l.price_amount')}
     ),
     -- Collapses same-seller reposts (identical title, same product,
     -- different listing ids - confirmed live 2026-09-02: two "IPHONE 14"
     -- listings posted 64s apart, same price) down to one row, same
     -- byte-identical-title heuristic computeRepostIds already uses on the
     -- product page (repostDetection.ts) - without this, /deals ranked the
     -- same real-world item twice. Keeps the earliest listing (accurate
     -- days_listed); COALESCE fallback keeps untitled listings (rare) from
     -- over-merging into one.
     deal_deduped AS (
       SELECT DISTINCT ON (product_id, COALESCE(lower(trim(title)), listing_id)) *
       FROM deal
       ORDER BY product_id, COALESCE(lower(trim(title)), listing_id), listed_at ASC NULLS LAST, listing_id
     ),
     filtered AS (
       SELECT
         deal_deduped.*,
         (reference_price - ask_price) AS profit_pesos,
         CASE WHEN reference_price > 0 THEN round(((reference_price - ask_price) / reference_price) * 100) ELSE NULL END AS discount_percent,
         (tier IS NULL OR (tier = 'llm_estimate' AND COALESCE(peer_sample_size, 0) <= 1)) AS is_low_confidence
       FROM deal_deduped
       WHERE ask_price >= ${minPricePlaceholder}
         -- Same magnitude-outlier guard detectAndRecordDiscountNotifications
         -- applies before ever recording a discount (src/domains/marketplace/
         -- storage/listings.ts) - a joke/decoy ask (e.g. ₱700 for an iPhone
         -- 16 Pro Max, confirmed live 2026-09-02) is 10x+ below its own
         -- reference price and would otherwise rank as the single best "deal"
         -- on the page. Skipped only when there's no reference_price at all
         -- (nothing to compare against - those rows are already routed to the
         -- low-confidence bucket by the tier IS NULL branch below).
         AND (reference_price IS NULL OR ask_price BETWEEN reference_price / 10 AND reference_price * 10)
         AND (tier IS NULL OR (tier = 'llm_estimate' AND COALESCE(peer_sample_size, 0) <= 1)) = ${lowConfidenceOnlyPlaceholder}
         AND (${lowConfidenceOnlyPlaceholder} OR reference_price - ask_price >= ${minProfitPlaceholder})
         AND (${lowConfidenceOnlyPlaceholder} OR ${TIER_RANK_SQL} >= ${minTierPlaceholder})
         ${categoryClause}
         ${daysListedClause}
         ${searchClause}
     ),
     -- Ranks each category's own deals separately (same ordering as the
     -- final list) so DEALS_CATEGORY_CAP can cut a category off before it
     -- fills the whole page - see that constant's comment above. NULL
     -- categories (the ~2,822 pre-2026-08-23 products never backfilled) are
     -- grouped into their own bucket via COALESCE so they're capped the same
     -- way instead of being exempt.
     capped AS (
       SELECT filtered.*,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(category, '')
           ORDER BY ${TIER_RANK_SQL} DESC, profit_pesos DESC NULLS LAST, listing_id
         ) AS category_rank
       FROM filtered
     )
     SELECT *
     FROM capped
     -- Cap only applies to the main ranked list, not the low-confidence
     -- bucket (that one isn't tier/profit-ranked the same way).
     WHERE ${lowConfidenceOnlyPlaceholder} OR category_rank <= ${categoryCapPlaceholder}
     -- Tier first (sold comps > peer listings > llm estimate - stronger
     -- evidence always outranks placement, per direct instruction
     -- 2026-09-02), profit only breaks ties within the same tier - without
     -- this a huge-profit llm_estimate guess could rank above a modest but
     -- real sold-comps deal.
     ORDER BY ${TIER_RANK_SQL} DESC, profit_pesos DESC NULLS LAST, listing_id
     LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    params,
  )

  return (result.rows as Record<string, unknown>[]).map((r) => ({
    listing_id: r.listing_id as string,
    title: r.title as string,
    ask_price: Number(r.ask_price),
    photo_url: resolvePhotoUrls(r.stored_photo_urls, r.primary_photo_url)[0] ?? null,
    product_id: r.product_id as number | null,
    base_model: r.base_model as string | null,
    variant_tier: r.variant_tier as string | null,
    category: r.category as string | null,
    sub_category: r.sub_category as string | null,
    reference_price: toNullableNumber(r.reference_price),
    tier: r.tier as DealsConfidenceTier | null,
    comp_count: r.comp_count === null || r.comp_count === undefined ? null : Number(r.comp_count),
    profit_pesos: toNullableNumber(r.profit_pesos),
    discount_percent: toNullableNumber(r.discount_percent),
    days_listed: r.days_listed === null || r.days_listed === undefined ? null : Math.floor(Number(r.days_listed)),
    is_saved: r.is_saved as boolean,
    is_low_confidence: r.is_low_confidence as boolean,
  }))
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
// src/domains/marketplace/storage/listings.ts) right after a listing first
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
export async function getCollectKeywords(db: QueryClient): Promise<string[]> {
  const result = await db.query(`SELECT keyword FROM collect_keywords ORDER BY keyword`, [])
  return (result.rows as { keyword: string }[]).map((r) => r.keyword)
}

// Full-list replace rather than a diffed add/remove - the table is a
// handful of rows edited rarely from one shared dashboard, so the simplicity
// of "save the whole list" outweighs the cost of a delete-then-insert.
export async function replaceCollectKeywords(db: QueryClient, keywords: string[]): Promise<void> {
  await db.query(`DELETE FROM collect_keywords`, [])
  if (keywords.length === 0) return
  const valuesSql = keywords.map((_, i) => `($${i + 1})`).join(', ')
  await db.query(`INSERT INTO collect_keywords (keyword) VALUES ${valuesSql}`, keywords)
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
