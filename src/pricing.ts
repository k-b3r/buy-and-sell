export function buildPriceLookupPrompt(baseModel: string, variantTier: string | null): string {
  const productName = variantTier ? `${baseModel} (${variantTier})` : baseModel
  return `Search for the current secondhand/used market price range in PHP for "${productName}" in the
Philippines, based on real current listings (e.g. Facebook Marketplace, Carousell, Shopee).

End your response with exactly one line in this exact format, with no extra text after it:
PRICE_RANGE: <low>-<high> PHP

If you cannot find enough real listings to determine a range, omit that line entirely instead of guessing.`
}

export interface PriceRange {
  low: number
  high: number
  currency: string
}

const PRICE_RANGE_PATTERN = /PRICE_RANGE:\s*([\d,]+)-([\d,]+)\s*([A-Z]{3})/

export function parsePriceRangeResponse(text: string): PriceRange | null {
  const match = text.match(PRICE_RANGE_PATTERN)
  if (!match) return null
  return {
    low: Number(match[1].replace(/,/g, '')),
    high: Number(match[2].replace(/,/g, '')),
    currency: match[3],
  }
}
