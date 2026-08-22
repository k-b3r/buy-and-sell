import type { PriceRange } from './pricing'

export function buildNewPriceQuery(baseModel: string, variantTier: string | null): string {
  const productName = variantTier ? `${baseModel} (${variantTier})` : baseModel
  return `${productName} brand new retail price Philippines`
}

export const NEW_PRICE_SYSTEM_PROMPT =
  'You find current brand-new retail prices in Philippine Peso (PHP) for a consumer product, sold by official retailers or authorized dealers in the Philippines. Prefer official brand sites and known PH electronics retailers. If no reliable new-retail PHP price is found, set found to false and leave price fields null.'

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

export function parseNewPriceContent(content: unknown): PriceRange | null {
  if (typeof content !== 'object' || content === null) return null
  const { found, price_low, price_high } = content as RawNewPriceContent
  if (found !== true) return null
  if (typeof price_low !== 'number' || typeof price_high !== 'number') return null
  return { low: price_low, high: price_high, currency: 'PHP' }
}
