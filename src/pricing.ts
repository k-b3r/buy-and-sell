export interface PriceLookupCandidate {
  id: number
  base_model: string
  variant_tier: string | null
}

// Grounding can't be combined with structured output (confirmed live), so the
// response is free text with a fenced json block, same pattern as the
// enrichment prompt - not a generateJson schema call. Batching multiple
// products per call is a real, live-confirmed win (see plan doc): Gemini runs
// multiple internal searches per prompt, an arbitrary product mix in one call
// came back 5/5 correct with no cross-contamination in testing, unlike Exa
// (which only does one search per call and starves anything past the first
// product it happens to match).
export function buildPriceLookupPrompt(products: PriceLookupCandidate[]): string {
  const lines = products
    .map((p) => {
      const label = p.variant_tier ? `${p.base_model} (${p.variant_tier})` : p.base_model
      return `[id: ${p.id}] ${label}`
    })
    .join('\n')
  return `Search for the current secondhand/used market price range in PHP for each of the following
products in the Philippines, based on real current listings (e.g. Facebook Marketplace, Carousell, Shopee).

${lines}

Respond with a fenced json code block containing a JSON array, one object per product, in this exact shape:
\`\`\`json
[{"id": "<id>", "found": true, "price_low": <number>, "price_high": <number>, "currency": "PHP"}]
\`\`\`
If you cannot find enough real listings for a product to determine a range, respond with
{"id": "<id>", "found": false} for that product instead of guessing.`
}

export interface PriceRange {
  low: number
  high: number
  currency: string
}

export interface PriceLookupResult {
  id: string
  found: boolean
  price_low: number | null
  price_high: number | null
  currency: string | null
}

const JSON_BLOCK_PATTERN = /```json\s*([\s\S]*?)```/

export function parsePriceRangeResponse(text: string): PriceLookupResult[] | null {
  const match = text.match(JSON_BLOCK_PATTERN)
  if (!match) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const results: PriceLookupResult[] = []
  for (const item of parsed as Record<string, unknown>[]) {
    if (typeof item.id !== 'string' && typeof item.id !== 'number') continue
    const id = String(item.id)

    if (item.found !== true) {
      results.push({ id, found: false, price_low: null, price_high: null, currency: null })
      continue
    }
    if (typeof item.price_low !== 'number' || typeof item.price_high !== 'number') continue
    results.push({
      id,
      found: true,
      price_low: item.price_low,
      price_high: item.price_high,
      currency: typeof item.currency === 'string' ? item.currency : 'PHP',
    })
  }
  return results
}
