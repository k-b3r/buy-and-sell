import { toNullableNumber } from '../../platform/rows'
import { isMagnitudeOutlier, isPlaceholderPrice, medianCtes, notMagnitudeOutlierSql } from './clean-median'

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

export const DISCOUNT_SUMMARY_LATERAL = `
  LEFT JOIN LATERAL (
    -- price_lookup_excluded gated in the pool, not just on the final
    -- aggregate below: the "bands" CTE further down is computed
    -- independently of that later WHERE (CTEs materialize before it's
    -- applied), so an excluded product's real discount_bands leaked through
    -- even after best_discount_percent/discounted_listing_count correctly
    -- went null. Confirmed live 2026-08-23: "House and Lot"/"Item"/"Desktop
    -- PC" all still showed real band arrays despite being flagged excluded.
    WITH ${medianCtes({
      name: 'product_median',
      pool: 'SELECT pl.product_id, pl.price_amount FROM listings pl WHERE pl.product_id = p.id AND NOT p.price_lookup_excluded',
      minSample: 2,
    })},
    discounts AS (
      SELECT round(((m.clean_median_price - pp.price_amount) / m.clean_median_price) * 100) AS discount_percent
      FROM product_median_prices pp
      JOIN product_median m ON m.product_id = pp.product_id
      WHERE m.clean_median_price > 0
        AND ${notMagnitudeOutlierSql('pp.price_amount', 'm.raw_median_price')}
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
  used: { low: unknown; high: unknown; source: unknown },
  trained: { known: unknown; low: unknown; high: unknown },
): { low: number | null; high: number | null; source: string | null } {
  if (used.low !== null && used.low !== undefined) {
    return { low: toNullableNumber(used.low), high: toNullableNumber(used.high), source: used.source as string }
  }
  if (trained.known === true) {
    return { low: toNullableNumber(trained.low), high: toNullableNumber(trained.high), source: 'groq_trained' }
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

// "New" listings need a current retail search; anything else (the vast
// majority — "Used - Good", "Used - Fair", etc.) needs a secondhand/resale
// search instead. Facebook's condition labels are free text, not an enum,
// so this is a loose substring check rather than a fixed set. "used" is
// checked first and wins outright - "Used - like new" contains "new" but is
// never actually new-in-box, and used to get misread as New here, comparing
// a secondhand item against brand-new retail pricing (confirmed live via a
// Qwen3.5-9B/DeepSeek judgement eval, 2026-08-30: an 84%-battery iPhone XR
// and a "slightly used" Apple Pencil both got priced against retail instead
// of secondhand because of this).
export function isNewCondition(condition: string | null): boolean {
  if (condition === null) return false
  const lower = condition.toLowerCase()
  if (lower.includes('used')) return false
  return lower.includes('new')
}
