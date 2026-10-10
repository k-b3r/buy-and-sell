// The clean-median rule every peer-price reference in this codebase uses:
// take a product's valid listing prices (not junk, see isJunkPrice), compute the raw median, drop prices more than
// MAGNITUDE_OUTLIER_RATIO off it in either direction, and take the median of
// what's left. One implementation per side: computeMedians (JS, for callers
// that already hold the prices) and medianCtes (SQL, for queries that
// aggregate in Postgres). tests/integration/clean-median.int.test.ts checks
// the two agree on shared fixtures.

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

// SQL equivalent of isPlaceholderPrice above, negated - the single
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

// No real listing on this marketplace goes below this - anything under it is
// a placeholder/joke price ("₱12", "₱20"), not a real ask.
const JUNK_PRICE_FLOOR = 100

// Asks above this are keyboard-mash or scam prices, not real listings.
const JUNK_PRICE_CEILING = 50_000_000

// The one junk-price rule: below the floor or a placeholder digit pattern.
// Junk never enters a median, a listing-derived price range, or a parsed
// search-result price.
export function isJunkPrice(price: number): boolean {
  return price < JUNK_PRICE_FLOOR || price > JUNK_PRICE_CEILING || isPlaceholderPrice(price)
}

// SQL equivalent of isJunkPrice above, negated.
export function notJunkPriceSql(column: string): string {
  return `${column} >= ${JUNK_PRICE_FLOOR} AND ${notPlaceholderPriceSql(column)}`
}

// >10x or <0.1x the raw median is almost always a placeholder, scam, or
// typo, not a real ask.
const MAGNITUDE_OUTLIER_RATIO = 10

// The one outlier rule for hiding/excluding a price (listing-price-review.ts's
// tighter 5x band only flags a listing for an LLM read). Used two ways:
// computeListingDiscount excludes it from discount/reference-price
// analysis, and callers
// (getProductDetail/getListingDetail) also null out the listing's own
// price_amount entirely - a mathematically-outlier price isn't shown, not
// just unscored, since a >10x-median number is almost always a placeholder/
// scam/typo, not a real ask worth displaying at all.
// No median (null) means nothing to compare against: not an outlier. A
// non-positive reference can't be a real price, so nothing is in band
// against it (the deals filter's original behavior, now the shared rule).
export function isMagnitudeOutlier(price: number, rawMedianPrice: number | null): boolean {
  if (rawMedianPrice === null) return false
  if (rawMedianPrice <= 0) return true
  return price < rawMedianPrice / MAGNITUDE_OUTLIER_RATIO || price > rawMedianPrice * MAGNITUDE_OUTLIER_RATIO
}

// SQL equivalent of isMagnitudeOutlier above, negated - single source of
// truth for the price_min/max/avg aggregate and every clean median
// (notPlaceholderPriceSql alone requires >=3 digits, so a troll ₱2 or a
// troll ₱123456789 that doesn't happen to hit a digit-pattern isn't caught
// by it - confirmed live 2026-09-02: home/product-list page showed price
// ranges like ₱2-₱123,456,789).
export function notMagnitudeOutlierSql(column: string, medianColumn: string): string {
  return `(${medianColumn} IS NULL OR (${medianColumn} > 0 AND ${column} BETWEEN ${medianColumn} / ${MAGNITUDE_OUTLIER_RATIO} AND ${medianColumn} * ${MAGNITUDE_OUTLIER_RATIO}))`
}

// Fewer valid prices than this and a product has no median at all, raw or
// clean - one or two listings are noise, not a market. One bar for every
// peer reference: sold comps, peer median, discount detection, listing and
// product pages, comparables lists and listing-derived price ranges.
export const MIN_PEER_SAMPLE = 3

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

// percentile_cont(0.5)-equivalent: linear interpolation between the two
// middle values, matching Postgres's median exactly.
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = (sorted.length - 1) / 2
  return (sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2
}

// JS side of the rule, for getProductDetail, which already has every
// sibling listing's price in hand from one query and doesn't need a second
// round trip. Takes raw listing prices; junk and missing ones are dropped
// here, same as medianCtes' `<name>_prices`.
export function computeMedians(rawPrices: (number | null)[]): {
  rawMedian: number | null
  cleanMedian: number | null
  sampleSize: number
} {
  const prices = rawPrices.filter((p): p is number => p !== null && !isJunkPrice(p))
  if (prices.length < MIN_PEER_SAMPLE) return { rawMedian: null, cleanMedian: null, sampleSize: prices.length }
  const rawMedian = median(prices) as number
  const clean = prices.filter((p) => !isMagnitudeOutlier(p, rawMedian))
  return { rawMedian, cleanMedian: median(clean), sampleSize: prices.length }
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
