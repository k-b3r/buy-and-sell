// Pure pricing/display predicates - no database access, no network.
//
// DUPLICATED, BY NECESSITY, from src/modules/pricing/price-rules.ts and
// clean-median.ts: only the predicates the browser needs (listingsFilters,
// ListingsGrid/Table and ListingPriceSummary badge already-fetched rows, so
// they cannot be an RPC call). Every other pricing rule (medians, outliers,
// discounts) is server-only; the dashboard gets their results over RPC. The
// two packages have no shared import path - same hand-sync constraint as the
// WORKERS list in app/admin/logs/page.tsx.
//
// KEEP IN SYNC WITH src/modules/pricing/price-rules.ts and clean-median.ts. A divergence here doesn't throw, it
// silently shows a different price verdict than the one the server computed.
// The row types come from ./shared.generated, not by hand.

import type { ListingPriceReview } from './shared.generated'

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
