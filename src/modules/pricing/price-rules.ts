import { toNullableNumber } from '../../platform/rows'
import type { DiscountBand, ListingPriceReview } from './types'
import { isJunkPrice, isMagnitudeOutlier, isPlaceholderPrice, MIN_PEER_SAMPLE } from './clean-median'

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

// jsonb_agg over an empty/filtered-out set comes back as SQL NULL, not '[]'.
export function toDiscountBands(value: unknown): DiscountBand[] {
  if (!Array.isArray(value)) return []
  return value.map((b) => ({
    bandFloor: Number((b as { bandFloor: unknown }).bandFloor),
    count: Number((b as { count: unknown }).count),
  }))
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

  if (price === null || n === null || n < MIN_PEER_SAMPLE) return NONE
  if (rawMedian === null || rawMedian <= 0 || cleanMedian === null || cleanMedian <= 0) return NONE
  if (isMagnitudeOutlier(price, rawMedian)) return NONE
  if (isJunkPrice(price)) return NONE

  return { discountPercent: Math.round(((cleanMedian - price) / cleanMedian) * 100), referencePrice: cleanMedian }
}

// Third and last fallback tier for secondhand price, below the two external
// sources in SECONDHAND_PRICE_LATERAL: Groq's own trained-knowledge guess
// (product_enrichment.trained_price_*) is explicitly scoped to secondhand
// too (see catalog/enrichment.ts's prompt) - unverified/no live grounding, but
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
