import type { ProductListingSummary } from './queries'

// price_review's range replaces the recorded price display when it has a real
// read on it; a review row with no determinable price (both null) falls back
// to the recorded price, same as no review row at all. is_negotiable is a
// wholly separate signal (NegotiableBadge), never coupled to which price shows.
// emptyLabel differs per view: the compact product listings show '—', the
// listing detail page spells it out.
export function formatListingPrice(
  l: Pick<ProductListingSummary, 'price_amount' | 'price_review'>,
  emptyLabel = '—',
): string {
  const review = l.price_review
  if (review && (review.price_low !== null || review.price_high !== null)) {
    if (review.price_low === review.price_high) {
      return review.price_low !== null ? `₱${review.price_low.toLocaleString()}` : emptyLabel
    }
    if (review.price_low !== null && review.price_high !== null) {
      return `₱${review.price_low.toLocaleString()}–₱${review.price_high.toLocaleString()}`
    }
  }
  return l.price_amount !== null ? `₱${l.price_amount.toLocaleString()}` : emptyLabel
}
