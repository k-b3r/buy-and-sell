import { PRODUCT_CATEGORIES } from './products'

export interface EnrichmentCandidate {
  id: number
  base_model: string
  variant_tier: string | null
  sibling_variants: string[]
  category: string | null
}

function formatProductLine(p: EnrichmentCandidate): string {
  const label = p.variant_tier ? `${p.base_model} (${p.variant_tier})` : p.base_model
  const siblings =
    p.sibling_variants.length > 0
      ? ` — other tracked variants of this base model: ${p.sibling_variants.join(', ')}`
      : ''
  return `[id: ${p.id}] ${label}${siblings}`
}

export function buildEnrichmentPrompt(products: EnrichmentCandidate[]): string {
  const lines = products.map(formatProductLine).join('\n')
  return `For each product below (identified by base model / variant) that you actually
recognize, provide:
- description: a concise description of what this product is (2-3 sentences)
- value_drivers: what affects this specific product's resale value - condition
  factors, common defects/wear points, meaningful spec or variant differences, what
  separates a well-priced unit from an overpriced one. Where "other tracked variants"
  are listed, write value_drivers specific to THIS variant, not the whole family -
  say how it differs from those siblings where that's relevant to value, not a
  generic description that could apply to any of them.
- has_trained_price_knowledge: true only if you have specific knowledge of this
  product's typical secondhand price from your training data, not a generic guess
- trained_price_low / trained_price_high: if has_trained_price_knowledge is true,
  your best estimate of the typical secondhand price range in PHP (Philippines) as
  of your training data; null otherwise
- category: exactly one of: ${PRODUCT_CATEGORIES.join(', ')}. Use "Other" if none
  genuinely fit rather than forcing a bad match.

Do not search - answer only from what you already know. If you do not recognize a
product at all (the name doesn't correspond to anything you actually know), omit it from the results array entirely - do not fabricate a description for a
product you don't actually know. If you recognize the product itself but have no
confident price knowledge, still include it, with has_trained_price_knowledge set
to false and the price fields null.

Products:
${lines}`
}

export const ENRICHMENT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          value_drivers: { type: 'string' },
          has_trained_price_knowledge: { type: 'boolean' },
          trained_price_low: { type: ['number', 'null'] },
          trained_price_high: { type: ['number', 'null'] },
          category: { type: 'string', enum: PRODUCT_CATEGORIES },
        },
        required: [
          'id',
          'description',
          'value_drivers',
          'has_trained_price_knowledge',
          'trained_price_low',
          'trained_price_high',
          'category',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const
