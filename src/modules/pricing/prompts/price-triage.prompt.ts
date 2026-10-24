// What the triage model is told, and the schema its answer must satisfy.
// Prose first on purpose: this is the file to edit when the triage verdicts
// need retuning. Parsing stays in domain/price-triage.ts.
import type { TriageCandidate } from '../types'

export function buildTriagePrompt(batch: TriageCandidate[]): string {
  const products = batch.map((c) => ({
    id: c.id,
    name: c.variant_tier ? `${c.base_model} ${c.variant_tier}` : c.base_model,
    category: c.category,
    description: c.description,
    reason: c.reason,
    listing_count: c.listing_count,
    median_ask_php: c.median_ask,
    sample_titles: c.sample_titles,
  }))
  return `You triage products from a Philippine secondhand marketplace (Facebook Marketplace) that our price lookup has excluded. For each product:

- verdict: "retry" if the name identifies one real, specific product (brand and model level) whose brand-new retail price a web search could find. "keep_excluded" if it is too generic (e.g. "Aircon", "Bag"), a part or accessory bundle, real estate, a service, or not a real product.
- is_specific_product and confidence ("high", "medium" or "low") for that judgment.
- price_low_php / price_high_php: your best estimate of the brand-new retail price range in the Philippines, in PHP, from your own knowledge. null for both if you don't know or it isn't a specific product.
- reasoning: one short sentence.

"reason" is why it was excluded. retail_not_found: a recent web price search found nothing. exa_no_result, exa_wide_spread, exa_low_confidence, claude_no_result: an older web search found nothing or only conflicting prices, which is evidence the product is too generic or does not exist; say "retry" for those only when the name is clearly a real specific model. Other reasons are earlier judgments (by an AI, a keyword rule or a curated list) that you may overturn with good evidence. sample_titles and median_ask_php show what sellers actually list under this name.

Return one result per product, keyed by product_id.

Products:
${JSON.stringify(products)}`
}

export const TRIAGE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          product_id: { type: 'integer' },
          verdict: { type: 'string', enum: ['retry', 'keep_excluded'] },
          is_specific_product: { type: 'boolean' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          price_low_php: { type: ['number', 'null'] },
          price_high_php: { type: ['number', 'null'] },
          reasoning: { type: 'string' },
        },
        required: [
          'product_id',
          'verdict',
          'is_specific_product',
          'confidence',
          'price_low_php',
          'price_high_php',
          'reasoning',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
}
