import { toNullableNumber } from '../../platform/rows'

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
  const bands = [...counts.entries()].sort((a, b) => b[0] - a[0]).map(([bandFloor, count]) => ({ bandFloor, count }))

  return { bestDiscountPercent: Math.max(...qualifying), discountedListingCount: qualifying.length, bands }
}

// price-lookup.ts's retail chain, in preference order: gemini_new_retail
// (primary, free - promoted 2026-09-02 since a free Gemini attempt can only
// ever save a paid Exa/Tavily call, never add cost) -> exa_new_retail
// (fallback 1, structured, cites sources) -> tavily_new_retail (fallback 2,
// free, regex-parsed) - see price-lookup.ts. Only
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
export const NEW_PRICE_LATERAL = `
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
export const SECONDHAND_PRICE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT price_low, price_high, source
    FROM product_price_history h
    WHERE h.product_id = p.id AND h.source IN
      ('manual_secondhand', 'gemini_grounding', 'exa_secondhand', 'tavily_secondhand', 'web_search', 'listing_prices', 'claude_code_secondhand')
    ORDER BY (h.source = 'manual_secondhand') DESC, (h.source = 'claude_code_secondhand') ASC, (h.source = 'listing_prices') ASC, h.checked_at DESC
    LIMIT 1
  ) up ON true
`

// jsonb_agg over an empty/filtered-out set comes back as SQL NULL, not '[]'.
export function toDiscountBands(value: unknown): DiscountBand[] {
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
export function notPlaceholderPriceSql(column: string): string {
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
export function notMagnitudeOutlierSql(column: string, medianColumn: string): string {
  return `(${medianColumn} IS NULL OR ${medianColumn} <= 0 OR ${column} BETWEEN ${medianColumn} / 10 AND ${medianColumn} * 10)`
}

export const DISCOUNT_SUMMARY_LATERAL = `
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

// Same magnitude-outlier heuristic as listing-price-review.ts's getPriceReviewCandidates
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
export function resolveSecondhandPrice(
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
export function toPriceReview(r: Record<string, unknown>): ListingPriceReview | null {
  if (r.price_review_is_negotiable === null || r.price_review_is_negotiable === undefined) return null
  return {
    is_negotiable: r.price_review_is_negotiable as boolean,
    price_low: toNullableNumber(r.price_review_low),
    price_high: toNullableNumber(r.price_review_high),
  }
}

export interface ListingPriceReview {
  is_negotiable: boolean
  price_low: number | null
  price_high: number | null
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

export function computeMedians(prices: number[]): {
  rawMedian: number | null
  cleanMedian: number | null
  sampleSize: number
} {
  const rawMedian = median(prices)
  if (rawMedian === null || rawMedian <= 0) return { rawMedian, cleanMedian: null, sampleSize: prices.length }
  const clean = prices.filter((p) => p >= rawMedian / 10 && p <= rawMedian * 10)
  return { rawMedian, cleanMedian: median(clean), sampleSize: prices.length }
}
