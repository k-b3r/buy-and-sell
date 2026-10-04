export interface PriceReviewCandidate {
  id: string
  title: string
  description: string | null
  price_amount: number
}

function formatListingLine(l: PriceReviewCandidate): string {
  return `[id: ${l.id}] title: "${l.title}" recorded_price: ₱${l.price_amount} desc: "${l.description ?? ''}"`
}

export function buildPriceReviewPrompt(listings: PriceReviewCandidate[]): string {
  const lines = listings.map(formatListingLine).join('\n')
  return `For each flagged listing below, read its title, description, and the price
Facebook recorded for it, and determine:
- is_negotiable: true if the text indicates the seller is open to negotiation,
  offers, or trade (e.g. "nego", "negotiable", "OBO", "open to swap/offers"),
  false otherwise
- price_low / price_high: your best read of the actual price(s) this listing is
  asking for, based on the text - not just the recorded number, which may be a
  placeholder, a data error, or per-unit/per-sqm pricing that doesn't reflect the
  real total price. If the listing covers multiple items at different prices (a
  bundle/compilation post), price_low/price_high should span that range. If a
  single price is intended, set price_low and price_high to the same value. If no
  real price can be determined at all from the text, set both to null.
- reasoning: one sentence explaining your read

Listings:
${lines}`
}

export const PRICE_REVIEW_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          is_negotiable: { type: 'boolean' },
          price_low: { type: ['number', 'null'] },
          price_high: { type: ['number', 'null'] },
          reasoning: { type: 'string' },
        },
        required: ['id', 'is_negotiable', 'price_low', 'price_high', 'reasoning'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const

export interface PriceReviewData {
  isNegotiable: boolean
  priceLow: number | null
  priceHigh: number | null
  reasoning: string
}

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
