// What the real-estate extraction model is told, and the schema its answer must
// satisfy. Prose first on purpose: edit here when extraction quality needs
// retuning. Normalisation and price-basis resolution stay in
// domain/extraction.ts.
import {
  NCR_LGUS,
  PRICE_BASES,
  PROPERTY_TYPES,
  RE_CONFIDENCES,
  RE_TAGS,
  parsePriceShorthand,
} from '../domain/extraction'
import type { RealEstateCandidate } from '../types'

export function buildRealEstatePrompt(candidates: RealEstateCandidate[]): string {
  const lines = candidates
    .map((c) => {
      const description = (c.description ?? '').slice(0, 800)
      return JSON.stringify({
        id: c.id,
        title: c.title,
        listed_price: c.price_amount,
        amounts_in_text: parsePriceShorthand(`${c.title} ${description}`),
        description,
      })
    })
    .join('\n')
  return `Extract structured real estate fields from each Philippine Facebook Marketplace listing below (one JSON object per line).

Rules:
- listing_type: "rent" if it offers a monthly rental or lease; "sale" if it is for sale (including pasalo/assume balance); "unknown" if unclear. Decide from the text, not from anything else.
- property_type: one of ${PROPERTY_TYPES.join(', ')}. A unit in a named tower, "residences" or condominium project, or one with a floor number or a parking slot, is a condo even if the seller calls it a house.
- listed_price is what the seller typed into Facebook's price field. When it is small it is unreliable (it can mean thousands, hundred-thousands or millions), so never use a small listed_price on its own. amounts_in_text lists amounts found in the text (it can include unrelated numbers). Take the price from the text. If the text states no price and listed_price is not a plausible full price, set price_basis to "unresolved" and price_php to null.
- price_php is the price in whole pesos. price_basis says what it is: "total" (full sale price), "per_sqm" (price per square meter), "monthly" (monthly rent), "equity" (only a downpayment or the amount to take over a loan on a pasalo/assume deal), or "unresolved" when you cannot tell (then price_php is null). On a pasalo/assume deal, an "asking cash out" or downpayment amount is equity, not the total, unless the text also states the full selling price.
- lot_sqm and floor_sqm are in square meters. Convert square feet (x0.0929) and hectares (x10000). Use null when not stated. If the text gives a range, use null.
- bedrooms and bathrooms are counts (0 for a studio); null when not stated.
- project_name is the building, condo or subdivision name as written; null when none.
- area_text is the city or district named in the text. If it is in Metro Manila, use exactly one of: ${NCR_LGUS.join(', ')} (BGC is Taguig). Otherwise copy the place as written. null when not stated.
- tags: any of ${RE_TAGS.join(', ')} that the text clearly states. Use room_share when only a room, a bedspace or a roommate slot is offered, not a whole unit.
- confidence: "high" when the key fields are stated plainly, "medium" when you inferred some, "low" when mostly guessing. Never guess a value: use null.

Listings:
${lines}`
}

const nullable = (type: string) => ({ type: [type, 'null'] })

export const REAL_ESTATE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          listing_type: { type: 'string', enum: ['sale', 'rent', 'unknown'] },
          property_type: { type: 'string', enum: [...PROPERTY_TYPES] },
          price_php: nullable('number'),
          price_basis: { type: 'string', enum: [...PRICE_BASES] },
          lot_sqm: nullable('number'),
          floor_sqm: nullable('number'),
          bedrooms: nullable('number'),
          bathrooms: nullable('number'),
          project_name: nullable('string'),
          area_text: nullable('string'),
          tags: { type: 'array', items: { type: 'string', enum: [...RE_TAGS] } },
          confidence: { type: 'string', enum: [...RE_CONFIDENCES] },
        },
        required: [
          'id',
          'listing_type',
          'property_type',
          'price_php',
          'price_basis',
          'lot_sqm',
          'floor_sqm',
          'bedrooms',
          'bathrooms',
          'project_name',
          'area_text',
          'tags',
          'confidence',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const
