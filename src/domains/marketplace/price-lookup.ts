export interface PriceRange {
  low: number
  high: number
  currency: string
}

export interface PriceLookupCandidate {
  id: number
  base_model: string
  variant_tier: string | null
  description: string | null
  sibling_variants: string[]
}

const WIDE_SPREAD_RATIO = 4

// A spread this wide usually means the search grounded to a whole product
// tier or market segment, not one specific product.
export function isWideSpread(price: PriceRange, maxRatio = WIDE_SPREAD_RATIO): boolean {
  return price.high > price.low * maxRatio
}

function productLabel(baseModel: string, variantTier: string | null): string {
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

// ---- Gemini: secondhand, primary source ----
// Google Search grounding can't combine with responseSchema (confirmed live,
// see GeminiClient's own comment) - so this asks for a fenced json block in
// free text, same proven pattern the pre-Claude secondhand-price-lookup used.
export function buildGeminiSecondhandPrompt(candidate: PriceLookupCandidate): string {
  const label = productLabel(candidate.base_model, candidate.variant_tier)
  return `Search for the current secondhand/used market price range in PHP for: ${label}, based on real current listings (e.g. Facebook Marketplace, Carousell, Shopee) in the Philippines.${disambiguationContext(candidate)}

Respond with a fenced json code block in this exact shape:
\`\`\`json
{"found": true, "price_low": <number>, "price_high": <number>}
\`\`\`
If you cannot find enough real listings to determine a reliable range, respond with {"found": false} instead of guessing.`
}

const JSON_BLOCK_PATTERN = /```json\s*([\s\S]*?)```/

export function parseGeminiPriceResponse(text: string): PriceRange | null {
  const match = text.match(JSON_BLOCK_PATTERN)
  if (!match) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const r = parsed as Record<string, unknown>
  if (r.found !== true) return null
  if (typeof r.price_low !== 'number' || typeof r.price_high !== 'number') return null
  return { low: r.price_low, high: r.price_high, currency: 'PHP' }
}

// ---- Exa: secondhand, fallback 1 ----
export function buildExaSecondhandQuery(candidate: PriceLookupCandidate): string {
  return `current secondhand used market price of ${productLabel(candidate.base_model, candidate.variant_tier)} in the Philippines`
}

export function buildExaSecondhandSystemPrompt(candidate: PriceLookupCandidate): string {
  return (
    'Find the current secondhand (used) market price range in Philippine Peso (PHP) from real current listings ' +
    '(e.g. Facebook Marketplace, Carousell, Shopee).' +
    disambiguationContext(candidate) +
    ' If you cannot find a reliable price, set found to false rather than guessing.'
  )
}

export const EXA_SECONDHAND_SCHEMA = {
  type: 'object',
  required: ['found'],
  additionalProperties: false,
  properties: {
    found: { type: 'boolean', description: 'true if a reliable current PHP secondhand price was found' },
    price_low: { type: 'number', description: 'lowest observed price in PHP' },
    price_high: { type: 'number', description: 'highest observed price in PHP' },
  },
} as const

// Exa's /search with outputSchema returns the structured result at
// response.output.content - same shape discount-verification.ts's
// EXA_SUMMARY_SCHEMA call already relies on.
export function parseExaPriceResponse(response: unknown): PriceRange | null {
  if (typeof response !== 'object' || response === null) return null
  const content = (response as { output?: { content?: unknown } }).output?.content
  if (typeof content !== 'object' || content === null) return null
  const r = content as Record<string, unknown>
  if (r.found !== true) return null
  if (typeof r.price_low !== 'number' || typeof r.price_high !== 'number') return null
  return { low: r.price_low, high: r.price_high, currency: 'PHP' }
}

// ---- Tavily: sole retail source, and secondhand fallback 2 (last resort) ----
export function buildTavilyQuery(kind: 'retail' | 'secondhand', candidate: PriceLookupCandidate): string {
  const label = productLabel(candidate.base_model, candidate.variant_tier)
  return kind === 'retail'
    ? `current brand-new retail price of ${label} in the Philippines`
    : `current secondhand used market price of ${label} in the Philippines`
}

// Tavily's include_answer has no structured output - per the
// pipeline-consolidation plan's decided approach, this extracts PHP amounts
// via regex rather than spending a second LLM call just to structure free
// text. Matches ₱/PHP-prefixed comma-grouped numbers (3+ digits) - a bare
// 1-2 digit number is far more likely a spec/year than a price, so it's
// excluded rather than risked.
const PRICE_AMOUNT_PATTERN = /(?:₱|PHP\s?)\s?([\d,]{3,})(?:\.\d+)?/gi

export function parseTavilyPriceAnswer(text: string | null): PriceRange | null {
  if (!text) return null
  const amounts: number[] = []
  for (const match of text.matchAll(PRICE_AMOUNT_PATTERN)) {
    const n = Number(match[1].replace(/,/g, ''))
    if (Number.isFinite(n) && n >= 100 && n <= 10_000_000) amounts.push(n)
  }
  if (amounts.length === 0) return null
  return { low: Math.min(...amounts), high: Math.max(...amounts), currency: 'PHP' }
}
