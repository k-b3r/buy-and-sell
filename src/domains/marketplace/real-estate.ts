export const PROPERTY_TYPES = ['house_and_lot', 'condo', 'land', 'commercial', 'other'] as const
export const LISTING_TYPES = ['sale', 'rent'] as const
export const PRICE_BASES = ['total', 'per_sqm', 'monthly', 'equity', 'unresolved'] as const
export const RE_CONFIDENCES = ['high', 'medium', 'low'] as const
export const RE_TAGS = ['pasalo', 'foreclosure', 'rfo', 'preselling', 'has_title', 'furnished'] as const

// The 16 cities plus the one municipality (Pateros) of Metro Manila.
export const NCR_LGUS = [
  'Caloocan', 'Las Piñas', 'Makati', 'Malabon', 'Mandaluyong', 'Manila', 'Marikina', 'Muntinlupa', 'Navotas',
  'Parañaque', 'Pasay', 'Pasig', 'Pateros', 'Quezon City', 'San Juan', 'Taguig', 'Valenzuela',
] as const

export type PropertyType = (typeof PROPERTY_TYPES)[number]
export type ListingType = (typeof LISTING_TYPES)[number]
export type PriceBasis = (typeof PRICE_BASES)[number]
export type RealEstateConfidence = (typeof RE_CONFIDENCES)[number]
export type RealEstateTag = (typeof RE_TAGS)[number]

export interface RealEstateCandidate {
  id: string
  title: string
  description: string | null
  price_amount: number | null
  source_hash: string
}

export interface RealEstateFields {
  listing_type: ListingType | null
  property_type: PropertyType
  price_php: number | null
  price_basis: PriceBasis
  lot_sqm: number | null
  floor_sqm: number | null
  bedrooms: number | null
  bathrooms: number | null
  project_name: string | null
  area_text: string | null
  tags: RealEstateTag[]
  confidence: RealEstateConfidence
}

const UNIT_MULTIPLIER: Record<string, number> = { million: 1e6, mil: 1e6, mn: 1e6, m: 1e6, thousand: 1e3, k: 1e3 }
const SHORTHAND = /(?:₱|php\.?|\bp)?\s?(\d+(?:[.,]\d+)?)\s?(million|mil|mn|m|thousand|k)\b/gi

// Advisory only: shown to the LLM as "amounts the text seems to state". It is
// deliberately liberal (dimensions like "5m x 10m" are filtered, other noise is
// left for the model to discard) because the model, not this, decides the price.
export function parsePriceShorthand(text: string): number[] {
  const found = new Set<number>()
  for (const m of text.matchAll(SHORTHAND)) {
    const after = text.slice((m.index ?? 0) + m[0].length)
    const before = text.slice(0, m.index ?? 0)
    // Skip dimensions like "5m x 10m": the first number is followed by "x <digit>",
    // the second is preceded by "<digit>[m] x".
    if (/^\s*x\s*\d/i.test(after) || /\d\s?m?\s*x\s*$/i.test(before)) continue
    const value = Number(m[1].replace(',', '.')) * UNIT_MULTIPLIER[m[2].toLowerCase()]
    if (Number.isFinite(value) && value >= 500) found.add(Math.round(value))
  }
  return [...found].sort((a, b) => a - b)
}

const NCR_ALIASES: [RegExp, string][] = [
  [/\bbgc\b|\bfort bonifacio\b|\bbonifacio global city\b/i, 'Taguig'],
  [/\balabang\b/i, 'Muntinlupa'],
  [/\beastwood\b/i, 'Quezon City'],
  [/\bqc\b/i, 'Quezon City'],
  [/\blas pinas\b/i, 'Las Piñas'],
  [/\bparanaque\b/i, 'Parañaque'],
]

export function normalizeNcrArea(text: string | null): string | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed) return null
  for (const name of NCR_LGUS) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(trimmed)) return name
  }
  for (const [pattern, name] of NCR_ALIASES) {
    if (pattern.test(trimmed)) return name
  }
  return trimmed.slice(0, 100)
}

const BOUNDS: Record<Exclude<PriceBasis, 'unresolved'>, [number, number]> = {
  total: [100_000, 5_000_000_000],
  monthly: [1_000, 1_000_000],
  per_sqm: [500, 5_000_000],
  equity: [10_000, 50_000_000],
}

function inBounds(basis: PriceBasis, price: number): boolean {
  if (basis === 'unresolved') return false
  const [lo, hi] = BOUNDS[basis]
  return price >= lo && price <= hi
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function boundedOrNull(value: unknown, min: number, max: number): number | null {
  const n = numOrNull(value)
  return n !== null && n >= min && n <= max ? n : null
}

function countOrNull(value: unknown): number | null {
  const n = boundedOrNull(value, 0, 50)
  return n === null ? null : Math.round(n)
}

function stringOrNull(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t ? t.slice(0, max) : null
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null
}

function lowerConfidence(c: RealEstateConfidence, to: RealEstateConfidence): RealEstateConfidence {
  return RE_CONFIDENCES.indexOf(c) >= RE_CONFIDENCES.indexOf(to) ? c : to
}

export function normalizeRealEstateItem(rawItem: unknown, candidate: RealEstateCandidate): RealEstateFields | null {
  if (typeof rawItem !== 'object' || rawItem === null) return null
  const r = rawItem as Record<string, unknown>
  if (typeof r.property_type !== 'string' || typeof r.price_basis !== 'string') return null

  const listingType = oneOf(LISTING_TYPES, r.listing_type)
  const propertyType = oneOf(PROPERTY_TYPES, r.property_type) ?? 'other'
  let confidence = oneOf(RE_CONFIDENCES, r.confidence) ?? 'low'

  const llmBasis = oneOf(PRICE_BASES, r.price_basis) ?? 'unresolved'
  const llmPrice = numOrNull(r.price_php)
  let price: number | null = null
  let basis: PriceBasis = 'unresolved'
  if (llmPrice !== null && inBounds(llmBasis, llmPrice)) {
    price = llmPrice
    basis = llmBasis
  } else {
    const fallbackBasis: PriceBasis = listingType === 'rent' ? 'monthly' : 'total'
    if (candidate.price_amount !== null && inBounds(fallbackBasis, candidate.price_amount)) {
      price = candidate.price_amount
      basis = fallbackBasis
      confidence = lowerConfidence(confidence, 'medium')
    } else {
      confidence = 'low'
    }
  }

  const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is RealEstateTag => oneOf(RE_TAGS, t) !== null) : []

  return {
    listing_type: listingType,
    property_type: propertyType,
    price_php: price,
    price_basis: basis,
    lot_sqm: boundedOrNull(r.lot_sqm, 1, 10_000_000),
    floor_sqm: boundedOrNull(r.floor_sqm, 1, 1_000_000),
    bedrooms: countOrNull(r.bedrooms),
    bathrooms: countOrNull(r.bathrooms),
    project_name: stringOrNull(r.project_name, 120),
    area_text: normalizeNcrArea(stringOrNull(r.area_text, 100)),
    tags,
    confidence,
  }
}

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
- property_type: one of ${PROPERTY_TYPES.join(', ')}.
- listed_price is what the seller typed into Facebook's price field. When it is small it is unreliable (it can mean thousands, hundred-thousands or millions), so never use a small listed_price on its own. amounts_in_text lists amounts found in the text (it can include unrelated numbers). Take the price from the text. If the text states no price and listed_price is not a plausible full price, set price_basis to "unresolved" and price_php to null.
- price_php is the price in whole pesos. price_basis says what it is: "total" (full sale price), "per_sqm" (price per square meter), "monthly" (monthly rent), "equity" (only a downpayment or the amount to take over a loan on a pasalo/assume deal), or "unresolved" when you cannot tell (then price_php is null).
- lot_sqm and floor_sqm are in square meters. Convert square feet (x0.0929) and hectares (x10000). Use null when not stated. If the text gives a range, use null.
- bedrooms and bathrooms are counts (0 for a studio); null when not stated.
- project_name is the building, condo or subdivision name as written; null when none.
- area_text is the city or district named in the text. If it is in Metro Manila, use exactly one of: ${NCR_LGUS.join(', ')} (BGC is Taguig). Otherwise copy the place as written. null when not stated.
- tags: any of ${RE_TAGS.join(', ')} that the text clearly states.
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
          'id', 'listing_type', 'property_type', 'price_php', 'price_basis', 'lot_sqm', 'floor_sqm',
          'bedrooms', 'bathrooms', 'project_name', 'area_text', 'tags', 'confidence',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const
