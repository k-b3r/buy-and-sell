import { JUNK_PRICE_FLOOR, MAGNITUDE_OUTLIER_RATIO, MIN_PEER_SAMPLE } from '../clean-median'

// Shared SQL fragments: the SQL side of the junk-price, magnitude-outlier and
// clean-median rules in clean-median.ts, the peer-listing scope, and the
// price laterals catalog and collection queries join. Constant strings and
// pure builders only, no database calls. Exported through pricing/index.ts.

// SQL equivalent of isPlaceholderPrice (clean-median.ts), negated - the single
// source-of-truth snippet every SQL price filter uses.
export function notPlaceholderPriceSql(column: string): string {
  return `NOT (
    length(trunc(${column})::text) >= 3
    AND (
      trunc(${column})::text ~ '^(\\d+)\\1+$'
      OR trunc(${column})::text ~ '012|123|234|345|456|567|678|789'
    )
  )`
}

// SQL equivalent of isJunkPrice (clean-median.ts), negated.
export function notJunkPriceSql(column: string): string {
  return `${column} >= ${JUNK_PRICE_FLOOR} AND ${notPlaceholderPriceSql(column)}`
}

// SQL equivalent of isMagnitudeOutlier (clean-median.ts), negated - single source of
// truth for the price_min/max/avg aggregate and every clean median
// (notPlaceholderPriceSql alone requires >=3 digits, so a troll ₱2 or a
// troll ₱123456789 that doesn't happen to hit a digit-pattern isn't caught
// by it - confirmed live 2026-09-02: home/product-list page showed price
// ranges like ₱2-₱123,456,789).
export function notMagnitudeOutlierSql(column: string, medianColumn: string): string {
  return `(${medianColumn} IS NULL OR (${medianColumn} > 0 AND ${column} BETWEEN ${medianColumn} / ${MAGNITUDE_OUTLIER_RATIO} AND ${medianColumn} * ${MAGNITUDE_OUTLIER_RATIO}))`
}

// A sold listing stays a peer this long after selling: recent sales are
// still the market, older ones are stale asks.
const PEER_SOLD_WINDOW_DAYS = 30
// Same idea for a listing flagged removed (flagged_removed_at): a recent
// takedown was still a market ask, an old one is stale and stops counting.
const PEER_REMOVED_WINDOW_DAYS = 30

// The one peer scope for every peer median (discount detection's fallback,
// the deals page's peer tier, product and listing pages, similar-listings
// evidence): active listings plus listings sold in the last
// PEER_SOLD_WINDOW_DAYS, minus listings flagged removed more than
// PEER_REMOVED_WINDOW_DAYS ago. Sold comps (sold listings only) are a
// separate tier.
export function peerListingSql(alias: string): string {
  const notStaleSold = `(${alias}.sold_at IS NULL OR ${alias}.sold_at >= now() - interval '${PEER_SOLD_WINDOW_DAYS} days')`
  const notStaleRemoved = `(${alias}.flagged_removed_at IS NULL OR ${alias}.flagged_removed_at >= now() - interval '${PEER_REMOVED_WINDOW_DAYS} days')`
  return `(${notStaleSold} AND ${notStaleRemoved})`
}

export interface MedianCtesOptions {
  // Prefix for the CTEs this emits: `<name>_prices`, `<name>_raw` (clean
  // only) and `<name>`.
  name: string
  // A SELECT returning at least product_id and price_amount: the listings in
  // scope (sold/active, one product or all, excluded products or not). Any
  // extra columns carry through to `<name>_prices`.
  pool: string
  // false emits only the raw median, for callers that just need the outlier
  // band and shouldn't pay for a second percentile pass.
  clean?: boolean
}

// SQL side of the rule. `<name>_prices` holds the pool's valid rows;
// `<name>` holds one row per product with raw_median_price and sample_size,
// plus clean_median_price unless clean is false. Both medians are NULL below
// MIN_PEER_SAMPLE (sample_size still counts, e.g. for the deals page's
// low-confidence check). Products with no valid price get no row at all.
export function medianCtes({ name, pool, clean = true }: MedianCtesOptions): string {
  const prices = `${name}_prices`
  const pricesCte = `${prices} AS (
    SELECT * FROM (${pool}) pool
    WHERE price_amount IS NOT NULL AND ${notJunkPriceSql('price_amount')}
  )`
  const rawSelect = `SELECT product_id,
      CASE WHEN count(*) >= ${MIN_PEER_SAMPLE} THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY price_amount) END AS raw_median_price,
      count(*) AS sample_size
    FROM ${prices} GROUP BY product_id`
  if (!clean) return `${pricesCte},\n  ${name} AS (\n    ${rawSelect}\n  )`

  return `${pricesCte},
  ${name}_raw AS (
    ${rawSelect}
  ),
  ${name} AS (
    SELECT r.product_id, r.raw_median_price, r.sample_size,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pp.price_amount)
       FROM ${prices} pp
       WHERE pp.product_id = r.product_id AND r.raw_median_price IS NOT NULL
         AND ${notMagnitudeOutlierSql('pp.price_amount', 'r.raw_median_price')}) AS clean_median_price
    FROM ${name}_raw r
  )`
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
      pool: `SELECT pl.product_id, pl.price_amount FROM listings pl
             WHERE pl.product_id = p.id AND NOT p.price_lookup_excluded AND ${peerListingSql('pl')}`,
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
