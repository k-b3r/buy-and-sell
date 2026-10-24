// Everything price lookup sends a provider, and the schema Exa's structured
// answer must satisfy. Prose first on purpose: edit here when a provider starts
// returning worse prices. Retrieval order, parsing and error handling stay in
// price-lookup.ts.
import type { PriceKind, PriceLookupCandidate } from '../types'

export function buildGeminiPrompt(kind: PriceKind, candidate: PriceLookupCandidate): string {
  const label = productLabel(candidate.base_model, candidate.variant_tier)
  const ask =
    kind === 'retail'
      ? `the current brand-new retail price range in PHP for: ${label}, from official brand sites or known Philippine electronics/appliance retailers`
      : `the current secondhand/used market price range in PHP for: ${label}, based on real current listings (e.g. Facebook Marketplace, Carousell, Shopee) in the Philippines`
  return `Search for ${ask}.${disambiguationContext(candidate)}

Respond with a fenced json code block in this exact shape:
\`\`\`json
{"found": true, "price_low": <number>, "price_high": <number>}
\`\`\`
If you cannot find enough reliable information to determine a real price range, respond with {"found": false} instead of guessing.`
}

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

export function buildTavilyQuery(kind: PriceKind, candidate: PriceLookupCandidate): string {
  const label = productLabel(candidate.base_model, candidate.variant_tier)
  return kind === 'retail'
    ? `current brand-new retail price of ${label} in the Philippines`
    : `current secondhand used market price of ${label} in the Philippines`
}

// Exa answers through /search with outputSchema: the structured result lands
// at response.output.content (same shape clients/market-context.ts relies on).
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

export function productLabel(baseModel: string, variantTier: string | null): string {
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
