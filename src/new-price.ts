import type { PriceRange } from './pricing'

export function buildNewPriceQuery(baseModel: string, variantTier: string | null): string {
  const productName = variantTier ? `${baseModel} (${variantTier})` : baseModel
  return `${productName} brand new retail price Philippines`
}

const BASE_SYSTEM_PROMPT =
  'You find current brand-new retail prices in Philippine Peso (PHP) for a consumer product, sold by official retailers or authorized dealers in the Philippines. Prefer official brand sites and known PH electronics retailers. Report the standard/regular retail price, not a temporary promo, flash sale, or discounted price — if only a promo price is available and the regular price is unclear, set found to false rather than reporting the promo price. If no reliable new-retail PHP price is found, set found to false and leave price fields null.'

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
  },
}

interface RawNewPriceContent {
  found?: unknown
  price_low?: unknown
  price_high?: unknown
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
