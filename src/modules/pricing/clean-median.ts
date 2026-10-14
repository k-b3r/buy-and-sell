// The clean-median rule every peer-price reference in this codebase uses:
// take a product's valid listing prices (not junk, see isJunkPrice), compute the raw median, drop prices more than
// MAGNITUDE_OUTLIER_RATIO off it in either direction, and take the median of
// what's left. One implementation per side: computeMedians (JS, for callers
// that already hold the prices) and medianCtes (SQL, for queries that
// aggregate in Postgres; store/fragments.ts). tests/integration/clean-median.int.test.ts checks
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

// No real listing on this marketplace goes below this - anything under it is
// a placeholder/joke price ("₱12", "₱20"), not a real ask.
export const JUNK_PRICE_FLOOR = 100

// The one junk-price rule: below the floor or a placeholder digit pattern.
// Junk never enters a median, a listing-derived price range, or a parsed
// search-result price.
export function isJunkPrice(price: number): boolean {
  return price < JUNK_PRICE_FLOOR || isPlaceholderPrice(price)
}

// >10x or <0.1x the raw median is almost always a placeholder, scam, or
// typo, not a real ask.
export const MAGNITUDE_OUTLIER_RATIO = 10

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

// Fewer valid prices than this and a product has no median at all, raw or
// clean - one or two listings are noise, not a market. One bar for every
// peer reference: sold comps, peer median, discount detection, listing and
// product pages, comparables lists and listing-derived price ranges.
export const MIN_PEER_SAMPLE = 3

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
