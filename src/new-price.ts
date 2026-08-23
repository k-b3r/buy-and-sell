import type { PriceRange } from './pricing'

export function buildNewPriceQuery(baseModel: string, variantTier: string | null): string {
  const productName = variantTier ? `${baseModel} (${variantTier})` : baseModel
  return `${productName} brand new retail price Philippines`
}

const BASE_SYSTEM_PROMPT =
  'You find current brand-new retail prices in Philippine Peso (PHP) for a consumer product, sold by official retailers or authorized dealers in the Philippines. Prefer official brand sites and known PH electronics retailers. Report the standard/regular retail price, not a temporary promo, flash sale, or discounted price — if only a promo price is available and the regular price is unclear, set found to false rather than reporting the promo price. If sources disagree on the price (e.g. an old launch-announcement article vs a current listing), prefer the most recently published source, not the oldest or the average. If no reliable new-retail PHP price is found, set found to false and leave price fields null.'

// description (product_enrichment's own generated description) and
// siblingVariants (other variant_tier values tracked under the same base
// model, e.g. "Pro"/"Pro Max"/"Mini") disambiguate which exact product is
// being priced — without this, a generic query like "iPhone 13" risks Exa
// grounding the price to a sibling variant's listing instead of the one
// actually requested.
export function buildNewPriceSystemPrompt(description: string | null, siblingVariants: string[]): string {
  let prompt = BASE_SYSTEM_PROMPT
  if (description) {
    prompt += ` Product context: ${description}`
  }
  if (siblingVariants.length > 0) {
    prompt += ` Other tracked variants of this same base model (price the requested one, not these): ${siblingVariants.join(', ')}`
  }
  return prompt
}

export const NEW_PRICE_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['found'],
  properties: {
    found: { type: 'boolean', description: 'true if a real current PHP new-retail price was found' },
    price_low: { type: 'number', description: 'lowest observed new-retail price in PHP' },
    price_high: { type: 'number', description: 'highest observed new-retail price in PHP' },
    release_year: { type: 'number', description: 'the year this product was originally released, if known' },
    is_discontinued: { type: 'boolean', description: 'true if the product is discontinued/no longer sold new' },
  },
}

interface RawNewPriceContent {
  found?: unknown
  price_low?: unknown
  price_high?: unknown
  release_year?: unknown
  is_discontinued?: unknown
}

interface ExaGroundingEntry {
  field?: unknown
  confidence?: unknown
}

interface ExaSearchResponse {
  output?: {
    content?: unknown
    grounding?: ExaGroundingEntry[]
  } | null
}

function getOutputContent(response: unknown): unknown {
  if (typeof response !== 'object' || response === null) return undefined
  return (response as ExaSearchResponse).output?.content
}

export function parseNewPriceContent(response: unknown): PriceRange | null {
  const content = getOutputContent(response)
  if (typeof content !== 'object' || content === null) return null
  const { found, price_low, price_high } = content as RawNewPriceContent
  if (found !== true) return null
  if (typeof price_low !== 'number' || typeof price_high !== 'number') return null
  return { low: price_low, high: price_high, currency: 'PHP' }
}

// Conservative: if either price field came back low-confidence, the whole
// row is reported low — a high-confidence price_low next to a low-confidence
// price_high isn't a high-confidence range.
export function extractNewPriceConfidence(response: unknown): string | null {
  if (typeof response !== 'object' || response === null) return null
  const grounding = (response as ExaSearchResponse).output?.grounding
  if (!Array.isArray(grounding)) return null
  const relevant = grounding.filter((g) => g.field === 'price_low' || g.field === 'price_high')
  if (relevant.length === 0) return null
  const low = relevant.find((g) => g.confidence === 'low')
  if (low) return 'low'
  const first = relevant[0]?.confidence
  return typeof first === 'string' ? first : null
}

const WIDE_SPREAD_RATIO = 4

// A spread this wide usually means Exa grounded to a whole product tier or
// market segment (e.g. "CPU Motherboard Bundle" returning ₱4,895-58,140),
// not one specific product — found live 2026-08-23. Independent safety net
// from confidence: Exa can report "high" confidence per field while the
// combined range is still meaningless.
export function isWideSpread(price: PriceRange, maxRatio = WIDE_SPREAD_RATIO): boolean {
  return price.high > price.low * maxRatio
}

export interface NewPriceMetadata {
  releaseYear: number | null
  isDiscontinued: boolean | null
}

// Free extra fields from the same already-paid-for search — same content
// object parseNewPriceContent reads, just the two fields it doesn't.
export function extractNewPriceMetadata(response: unknown): NewPriceMetadata {
  const content = getOutputContent(response)
  if (typeof content !== 'object' || content === null) return { releaseYear: null, isDiscontinued: null }
  const { release_year, is_discontinued } = content as RawNewPriceContent
  return {
    releaseYear: typeof release_year === 'number' ? release_year : null,
    isDiscontinued: typeof is_discontinued === 'boolean' ? is_discontinued : null,
  }
}
