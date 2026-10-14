// A recorded price this many times off the price named in the description
// (either direction) is treated as suspect and sent to the LLM review, even
// if it's within the magnitude-outlier band vs the product median. Catches
// the single-dropped-digit class (₱39,000 keyed as ₱3,900) that a 10x
// median band lets through - see getPriceReviewCandidates.
const DESCRIPTION_PRICE_DIVERGENCE_FACTOR = 5

// Keyword/currency-prefixed amount: "price 39k", "₱39,000", "asking 39000",
// "srp 52k". The {0,6} gap absorbs a short connector ("for ", ": ") between
// the keyword and the number without spanning into an unrelated later number.
const PREFIXED_PRICE_RE =
  /(?:₱|php|price[ds]?|asking|presyo|selling|srp)[^0-9₱]{0,6}₱?\s*([0-9][0-9,. ]*[0-9]|[0-9])\s*(k)?/i
// Bare thousands-abbreviated amount: "39k", "39 k". A plain integer with no
// prefix and no "k" is deliberately ignored - descriptions are full of
// unrelated numbers (storage sizes, battery %, model years).
const BARE_THOUSANDS_RE = /(?:^|[^0-9a-z.])([0-9]{1,4}(?:\.[0-9]+)?)\s*k\b/i

// Best-effort asking price from a listing's free-text description. Used only
// to flag price-review candidates (getPriceReviewCandidates), never as an
// authoritative price - the LLM makes the real call. Returns null when
// nothing price-shaped is found or the value is implausible (< ₱500 or
// > ₱50M).
export function extractDescriptionPrice(description: string | null): number | null {
  if (!description) return null

  let digits: string
  let thousands: boolean
  const prefixed = PREFIXED_PRICE_RE.exec(description)
  if (prefixed) {
    digits = prefixed[1]
    thousands = Boolean(prefixed[2])
  } else {
    const bare = BARE_THOUSANDS_RE.exec(description)
    if (!bare) return null
    digits = bare[1]
    thousands = true
  }

  const n = Number(digits.replace(/[,\s]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  const value = thousands ? n * 1000 : n
  if (value < 500 || value > 50_000_000) return null
  return value
}

export function descriptionPriceDiverges(
  description: string | null,
  priceAmount: number,
  factor = DESCRIPTION_PRICE_DIVERGENCE_FACTOR,
): boolean {
  if (!(priceAmount > 0)) return false
  const descriptionPrice = extractDescriptionPrice(description)
  if (descriptionPrice === null) return false
  return priceAmount * factor < descriptionPrice || priceAmount > descriptionPrice * factor
}
