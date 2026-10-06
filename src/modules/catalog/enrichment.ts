import { isProductCategory, PRODUCT_CATEGORIES } from './products'

export interface EnrichmentCandidate {
  id: number
  base_model: string
  variant_tier: string | null
  sibling_variants: string[]
  category: string | null
}

export interface EnrichmentData {
  description: string
  valueDrivers: string
  hasTrainedPriceKnowledge: boolean
  trainedPriceLow: number | null
  trainedPriceHigh: number | null
  isSpecificProduct: boolean
  confidence: 'high' | 'low'
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
- is_specific_product: true only if this base model names one real, specific,
  priceable product (a model/SKU/nameplate) - not a generic category noun like
  "Furniture" or "Motherboard", and not a bare brand with no model like
  "Lenovo Thinkpad" (real prices for that span too wide a range to mean
  anything as one product), even if you recognize the words.
- confidence: "high" if you're sure of your is_specific_product judgment,
  "low" if this could plausibly be outside your training knowledge either way
  (a genuinely new or obscure product) - don't force a confident guess.

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
          is_specific_product: { type: 'boolean' },
          confidence: { type: 'string', enum: ['high', 'low'] },
        },
        required: [
          'id',
          'description',
          'value_drivers',
          'has_trained_price_knowledge',
          'trained_price_low',
          'trained_price_high',
          'category',
          'is_specific_product',
          'confidence',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const

// Fields of one item of the model's `results` array, unvalidated.
interface RawEnrichmentItem {
  id?: unknown
  description?: unknown
  value_drivers?: unknown
  has_trained_price_knowledge?: unknown
  trained_price_low?: unknown
  trained_price_high?: unknown
  category?: unknown
  is_specific_product?: unknown
  confidence?: unknown
}

// What happens to the product's category once its enrichment is saved:
// 'keep' when it already has one, 'invalid' when it has none and the
// response's category isn't a valid one.
type CategoryDecision = { kind: 'keep' } | { kind: 'assign'; category: string } | { kind: 'invalid' }

type EnrichmentItemOutcome =
  | { kind: 'malformed'; idHint: string }
  | { kind: 'unknown-candidate'; id: string }
  | { kind: 'enriched'; candidate: EnrichmentCandidate; data: EnrichmentData; category: CategoryDecision }

// Validates one response item against the batch it answers. Category is
// best-effort, unlike the enrichment fields: a malformed category doesn't
// invalidate the enrichment itself. It only ever fills a gap: a candidate
// that already has a category (assigned at creation by product extraction)
// keeps it as-is. Any value is accepted (the model can return null or
// non-object entries) and reported as malformed rather than thrown.
export function parseEnrichmentItem(raw: unknown, batch: EnrichmentCandidate[]): EnrichmentItemOutcome {
  const item: RawEnrichmentItem = typeof raw === 'object' && raw !== null ? raw : {}
  if (
    typeof item.id !== 'string' ||
    typeof item.description !== 'string' ||
    typeof item.value_drivers !== 'string' ||
    typeof item.has_trained_price_knowledge !== 'boolean' ||
    typeof item.is_specific_product !== 'boolean' ||
    (item.confidence !== 'high' && item.confidence !== 'low')
  ) {
    return { kind: 'malformed', idHint: typeof item.id === 'string' ? item.id : '(missing/invalid id)' }
  }
  const id = item.id
  const candidate = batch.find((c) => String(c.id) === id)
  if (!candidate) return { kind: 'unknown-candidate', id }

  const data: EnrichmentData = {
    description: item.description,
    valueDrivers: item.value_drivers,
    hasTrainedPriceKnowledge: item.has_trained_price_knowledge,
    trainedPriceLow: typeof item.trained_price_low === 'number' ? item.trained_price_low : null,
    trainedPriceHigh: typeof item.trained_price_high === 'number' ? item.trained_price_high : null,
    isSpecificProduct: item.is_specific_product,
    confidence: item.confidence,
  }
  return { kind: 'enriched', candidate, data, category: decideCategory(candidate, item.category) }
}

function decideCategory(candidate: EnrichmentCandidate, category: unknown): CategoryDecision {
  if (candidate.category !== null) return { kind: 'keep' }
  if (isProductCategory(category)) return { kind: 'assign', category }
  return { kind: 'invalid' }
}
