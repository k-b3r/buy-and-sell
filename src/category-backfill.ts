import { PRODUCT_CATEGORIES } from './products'

export interface CategoryBackfillCandidate {
  id: number
  base_model: string
  variant_tier: string | null
}

function formatProductLine(p: CategoryBackfillCandidate): string {
  const label = p.variant_tier ? `${p.base_model} (${p.variant_tier})` : p.base_model
  return `[id: ${p.id}] ${label}`
}

export function buildCategoryBackfillPrompt(products: CategoryBackfillCandidate[]): string {
  const lines = products.map(formatProductLine).join('\n')
  return `For each product below, assign exactly one category from this fixed list:
${PRODUCT_CATEGORIES.join(', ')}

Use "Other" if none genuinely fit rather than forcing a bad match.

Products:
${lines}`
}

export const CATEGORY_BACKFILL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: { type: 'string', enum: PRODUCT_CATEGORIES },
        },
        required: ['id', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const
