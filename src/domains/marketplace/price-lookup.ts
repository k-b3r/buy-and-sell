export interface PriceRange {
  low: number
  high: number
  currency: string
}

export interface PriceLookupCandidate {
  id: number
  base_model: string
  variant_tier: string | null
  description: string | null
  sibling_variants: string[]
}

const WIDE_SPREAD_RATIO = 4

// A spread this wide usually means the search grounded to a whole product
// tier or market segment, not one specific product.
export function isWideSpread(price: PriceRange, maxRatio = WIDE_SPREAD_RATIO): boolean {
  return price.high > price.low * maxRatio
}

function productLabel(baseModel: string, variantTier: string | null): string {
  return variantTier ? `${baseModel} (${variantTier})` : baseModel
}

function disambiguationContext(candidate: PriceLookupCandidate): string {
  let context = ''
  if (candidate.description) context += ` Product context: ${candidate.description}.`
  if (candidate.sibling_variants.length > 0) {
    context += ` Other tracked variants of this same base model (price the requested one, not these): ${candidate.sibling_variants.join(', ')}.`
  }
  return context
}

export type PriceKind = 'retail' | 'secondhand'

// ---- Exa: primary source for both retail and secondhand ----
// Per a live head-to-head against Tavily (2026-08-31, 15 real candidates,
// see discount-verification.ts's fetchFreshMarketContext comment for the
// full record) - Exa cited sources and abstained honestly when it lacked
// real data, where Tavily confidently fabricated numbers with no citation
// trail. Same conclusion applies here: Exa first, Tavily only as a fallback.
export function buildExaQuery(kind: PriceKind, candidate: PriceLookupCandidate): string {
  const label = productLabel(candidate.base_model, candidate.variant_tier)
  return kind === 'retail'
    ? `current brand-new retail price of ${label} in the Philippines`
    : `current secondhand used market price of ${label} in the Philippines`
}

export function buildExaSystemPrompt(kind: PriceKind, candidate: PriceLookupCandidate): string {
  const base =
    kind === 'retail'
      ? 'Find the current brand-new retail price in Philippine Peso (PHP) from official brand sites and known PH electronics retailers - not a temporary promo or flash-sale price.'
      : 'Find the current secondhand (used) market price range in Philippine Peso (PHP) from real current listings (e.g. Facebook Marketplace, Carousell, Shopee).'
  return `${base}${disambiguationContext(candidate)} If you cannot find a reliable price, set found to false rather than guessing.`
}

export const EXA_PRICE_SCHEMA = {
  type: 'object',
  required: ['found'],
  additionalProperties: false,
  properties: {
    found: { type: 'boolean', description: 'true if a reliable current PHP price was found' },
    price_low: { type: 'number', description: 'lowest observed price in PHP' },
    price_high: { type: 'number', description: 'highest observed price in PHP' },
  },
} as const

// Exa's /search with outputSchema returns the structured result at
// response.output.content - same shape discount-verification.ts's
// EXA_SUMMARY_SCHEMA call already relies on.
export function parseExaPriceResponse(response: unknown): PriceRange | null {
  if (typeof response !== 'object' || response === null) return null
  const content = (response as { output?: { content?: unknown } }).output?.content
  if (typeof content !== 'object' || content === null) return null
  const r = content as Record<string, unknown>
  if (r.found !== true) return null
  if (typeof r.price_low !== 'number' || typeof r.price_high !== 'number') return null
  return { low: r.price_low, high: r.price_high, currency: 'PHP' }
}

// ---- Tavily: fallback for both, only tried once Exa fails/comes up empty ----
export function buildTavilyQuery(kind: PriceKind, candidate: PriceLookupCandidate): string {
  const label = productLabel(candidate.base_model, candidate.variant_tier)
  return kind === 'retail'
    ? `current brand-new retail price of ${label} in the Philippines`
    : `current secondhand used market price of ${label} in the Philippines`
}

// Tavily's include_answer has no structured output - per the
// pipeline-consolidation plan's decided approach, this extracts PHP amounts
// via regex rather than spending a second LLM call just to structure free
// text. Matches ₱/PHP-prefixed comma-grouped numbers (3+ digits) - a bare
// 1-2 digit number is far more likely a spec/year than a price, so it's
// excluded rather than risked.
const PRICE_AMOUNT_PATTERN = /(?:₱|PHP\s?)\s?([\d,]{3,})(?:\.\d+)?/gi

export function parseTavilyPriceAnswer(text: string | null): PriceRange | null {
  if (!text) return null
  const amounts: number[] = []
  for (const match of text.matchAll(PRICE_AMOUNT_PATTERN)) {
    const n = Number(match[1].replace(/,/g, ''))
    if (Number.isFinite(n) && n >= 100 && n <= 10_000_000) amounts.push(n)
  }
  if (amounts.length === 0) return null
  return { low: Math.min(...amounts), high: Math.max(...amounts), currency: 'PHP' }
}
