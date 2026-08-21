export interface EnrichmentCandidate {
  id: number
  base_model: string
  variant_tier: string | null
  sibling_variants: string[]
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
  return `For each product below (identified by base model / variant), provide:
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

Do not search - answer only from what you already know. If you don't recognize this
specific product or have no confident price knowledge, set has_trained_price_knowledge
to false and leave the price fields null - do not guess.

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
        },
        required: [
          'id',
          'description',
          'value_drivers',
          'has_trained_price_knowledge',
          'trained_price_low',
          'trained_price_high',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const
