// Pure pricing/display predicates - no database access, no network.
//
// DUPLICATED, BY NECESSITY, from src/modules/pricing/price-rules.ts. These same functions run
// server-side inside the SQL-backed queries there, and client-side here (
// ListingsView, ListingDetailContent and listingsFilters all filter/badge
// already-fetched rows in the browser, so they cannot be an RPC call). The
// two packages have no shared import path - same hand-sync constraint as the
// WORKERS list in app/admin/logs/page.tsx.
//
// KEEP IN SYNC WITH src/modules/pricing/price-rules.ts. A divergence here doesn't throw, it
// silently shows a different price verdict than the one the server computed.

export interface DiscountBand {
  bandFloor: number
  count: number
}

export interface DiscountSummary {
  bestDiscountPercent: number | null
  discountedListingCount: number
  bands: DiscountBand[]
}

export interface ListingPriceReview {
  is_negotiable: boolean
  price_low: number | null
  price_high: number | null
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
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

// Ascending-sequential digit runs anywhere in the price (123, 12345, but also
// embedded runs like the 456 inside 12456 - confirmed live 2026-08-23 against
// a real ₱12,456 listing that the old start-only-at-1 prefix check missed),
// repeated-digit runs (111, 9999), and repeated multi-digit blocks (6969,
// 696969 - joke/meme numbers). Distinct from magnitude-outlier detection:
// ₱123,456 falls well within 10x of a real ₱150,000 median yet is obviously
// not a real ask. Minimum length 3 (₱11, ₱99 are plausible real prices).
const ASCENDING_RUN_RE = /012|123|234|345|456|567|678|789/

export function isPlaceholderPrice(price: number): boolean {
  const digits = String(Math.trunc(Math.abs(price)))
  if (digits.length < 3) return false
  if (/^(\d+)\1+$/.test(digits)) return true
  return ASCENDING_RUN_RE.test(digits)
}

// >10x or <0.1x the raw median - the same pre-filter that makes a listing an
// enrich-listing-prices candidate, independent of whether that worker has
// reviewed it yet.
export function isMagnitudeOutlier(price: number, rawMedianPrice: number | null): boolean {
  if (rawMedianPrice === null || rawMedianPrice <= 0) return false
  return price < rawMedianPrice / 10 || price > rawMedianPrice * 10
}

// Magnitude outlier OR a placeholder digit pattern, independent of magnitude
// (e.g. "123"/"999" can sit well within 10x of a real median and still not be
// a real ask). Either condition means the price gets hidden entirely, not
// just excluded from discount scoring.
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
