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
