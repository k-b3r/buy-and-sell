export interface PriceRange {
  low: number
  high: number
  currency: string
}

export interface ClaudePriceCandidate {
  id: number
  base_model: string
  variant_tier: string | null
  description: string | null
  sibling_variants: string[]
}

export function buildClaudePriceQuery(baseModel: string, variantTier: string | null): string {
  const productName = variantTier ? `${baseModel} (${variantTier})` : baseModel
  return `Find the current retail (brand-new) price and the current secondhand (used) market price, both in Philippine Peso (PHP), for: ${productName}`
}

const BASE_SYSTEM_PROMPT =
  'You research current product prices in the Philippines using web search, for two categories at once. ' +
  'For "retail": search official brand sites and known PH electronics retailers for the standard/regular brand-new price - not a temporary promo, flash sale, or discounted price. If only a promo price is available and the regular price is unclear, set retail.found to false rather than reporting the promo price. ' +
  'For "secondhand": search real current listings (e.g. Facebook Marketplace, Carousell, Shopee) for the used/pre-owned market price range. ' +
  'If sources disagree on a price, prefer the most recently published source, not the oldest or the average. ' +
  'If you cannot find a reliable PHP price for a category, set that category\'s found to false and leave its price fields out rather than guessing.'

// description (product_enrichment's own generated description) and
// siblingVariants (other variant_tier values tracked under the same base
// model) disambiguate which exact product is being priced - same
// disambiguation new-price.ts relied on for Exa, needed here too since a
// generic query like "iPhone 13" risks the search grounding to a sibling
// variant instead of the one actually requested.
export function buildClaudePriceSystemPrompt(description: string | null, siblingVariants: string[]): string {
  let prompt = BASE_SYSTEM_PROMPT
  if (description) {
    prompt += ` Product context: ${description}`
  }
  if (siblingVariants.length > 0) {
    prompt += ` Other tracked variants of this same base model (price the requested one, not these): ${siblingVariants.join(', ')}`
  }
  return prompt
}

const PRICE_SIDE_SCHEMA = {
  type: 'object',
  required: ['found'],
  additionalProperties: false,
  properties: {
    found: { type: 'boolean', description: 'true if a reliable current PHP price was found for this category' },
    price_low: { type: 'number', description: 'lowest observed price in PHP' },
    price_high: { type: 'number', description: 'highest observed price in PHP' },
  },
}

export const CLAUDE_PRICE_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['retail', 'secondhand'],
  additionalProperties: false,
  properties: {
    retail: PRICE_SIDE_SCHEMA,
    secondhand: PRICE_SIDE_SCHEMA,
  },
}

export interface ClaudePriceResult {
  retail: PriceRange | null
  secondhand: PriceRange | null
}

interface RawPriceSide {
  found?: unknown
  price_low?: unknown
  price_high?: unknown
}

interface RawClaudePriceContent {
  retail?: RawPriceSide
  secondhand?: RawPriceSide
}

function parsePriceSide(side: RawPriceSide | undefined): PriceRange | null {
  if (!side || side.found !== true) return null
  if (typeof side.price_low !== 'number' || typeof side.price_high !== 'number') return null
  return { low: side.price_low, high: side.price_high, currency: 'PHP' }
}

// The schema-constrained JSON is the final text block in the response -
// earlier blocks are the model's server_tool_use/web_search_tool_result
// exchange with the web_search tool. A refusal (stop_reason "refusal") has
// no such text block and returns null for both sides.
function getFinalTextContent(response: unknown): unknown {
  if (typeof response !== 'object' || response === null) return undefined
  const content = (response as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const textBlocks = content.filter((block): block is { type: string; text: string } => {
    return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
  })
  const last = textBlocks[textBlocks.length - 1]
  if (!last) return undefined
  try {
    return JSON.parse(last.text)
  } catch {
    return undefined
  }
}

export function parseClaudePriceResponse(response: unknown): ClaudePriceResult {
  if (typeof response === 'object' && response !== null && (response as { stop_reason?: unknown }).stop_reason === 'refusal') {
    return { retail: null, secondhand: null }
  }
  const content = getFinalTextContent(response)
  if (typeof content !== 'object' || content === null) return { retail: null, secondhand: null }
  const { retail, secondhand } = content as RawClaudePriceContent
  return { retail: parsePriceSide(retail), secondhand: parsePriceSide(secondhand) }
}

const WIDE_SPREAD_RATIO = 4

// A spread this wide usually means the search grounded to a whole product
// tier or market segment, not one specific product - same signal
// new-price.ts's isWideSpread caught for Exa.
export function isWideSpread(price: PriceRange, maxRatio = WIDE_SPREAD_RATIO): boolean {
  return price.high > price.low * maxRatio
}
