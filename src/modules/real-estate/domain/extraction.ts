import type {
  ListingType,
  PriceBasis,
  PropertyType,
  RealEstateCandidate,
  RealEstateConfidence,
  RealEstateFields,
  RealEstateTag,
} from '../types'

export const PROPERTY_TYPES = [
  'house_and_lot',
  'condo',
  'land',
  'commercial',
  'other',
] as const satisfies readonly PropertyType[]
const LISTING_TYPES = ['sale', 'rent'] as const satisfies readonly ListingType[]
export const PRICE_BASES = [
  'total',
  'per_sqm',
  'monthly',
  'equity',
  'unresolved',
] as const satisfies readonly PriceBasis[]
export const RE_CONFIDENCES = ['high', 'medium', 'low'] as const satisfies readonly RealEstateConfidence[]
export const RE_TAGS = [
  'pasalo',
  'foreclosure',
  'rfo',
  'preselling',
  'has_title',
  'furnished',
  'room_share',
] as const satisfies readonly RealEstateTag[]

// The 16 cities plus the one municipality (Pateros) of Metro Manila.
export const NCR_LGUS = [
  'Caloocan',
  'Las Piñas',
  'Makati',
  'Malabon',
  'Mandaluyong',
  'Manila',
  'Marikina',
  'Muntinlupa',
  'Navotas',
  'Parañaque',
  'Pasay',
  'Pasig',
  'Pateros',
  'Quezon City',
  'San Juan',
  'Taguig',
  'Valenzuela',
] as const

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

// The model tends to answer 0 for "not stated". Zero bedrooms only means
// something for a condo (a studio); zero bathrooms never does.
function roomCount(value: unknown, zeroMeansStudio: boolean): number | null {
  const n = countOrNull(value)
  return n === 0 && !zeroMeansStudio ? null : n
}

function stringOrNull(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t ? t.slice(0, max) : null
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null
}

// Deterministic backstops for two mistakes seen in the 2026-09-25 spot check,
// since the model is not fully consistent run to run.
// 1. A pasalo "cash out" read as the full price: the text talks about taking over
//    a balance but never states a selling price, so the amount is equity.
const PASALO_EQUITY_HINT = /cash ?out|remaining balance|assume balance|assumption/i
const FULL_PRICE_HINT = /selling price|total (contract )?price|\btcp\b|full price/i
// 2. A single room, bedspace or roommate slot offered as if it were a whole unit.
const ROOM_SHARE_HINT = /room ?mate|bed ?space|condo sharing|room sharing|room for rent|looking for .{0,20}roommate/i

function lowerConfidence(c: RealEstateConfidence, to: RealEstateConfidence): RealEstateConfidence {
  return RE_CONFIDENCES.indexOf(c) >= RE_CONFIDENCES.indexOf(to) ? c : to
}

interface ResolvedPrice {
  price: number | null
  basis: PriceBasis
  confidence: RealEstateConfidence
}

// The model's price wins when it is plausible for its basis; otherwise the
// seller's listed price, read as total (or monthly for a rent), at most medium
// confidence; otherwise unresolved at low confidence.
function resolvePrice(
  r: Record<string, unknown>,
  listingType: ListingType | null,
  candidate: RealEstateCandidate,
): ResolvedPrice {
  const confidence = oneOf(RE_CONFIDENCES, r.confidence) ?? 'low'
  const llmBasis = oneOf(PRICE_BASES, r.price_basis) ?? 'unresolved'
  const llmPrice = numOrNull(r.price_php)
  if (llmPrice !== null && inBounds(llmBasis, llmPrice)) return { price: llmPrice, basis: llmBasis, confidence }

  const fallbackBasis: PriceBasis = listingType === 'rent' ? 'monthly' : 'total'
  if (candidate.price_amount !== null && inBounds(fallbackBasis, candidate.price_amount)) {
    return { price: candidate.price_amount, basis: fallbackBasis, confidence: lowerConfidence(confidence, 'medium') }
  }
  return { price: null, basis: 'unresolved', confidence: 'low' }
}

// Backstop 1 above: a pasalo total with cash-out wording and no stated full price is equity.
function applyPasaloEquityBackstop(resolved: ResolvedPrice, tags: RealEstateTag[], text: string): ResolvedPrice {
  const isEquity =
    resolved.basis === 'total' &&
    tags.includes('pasalo') &&
    PASALO_EQUITY_HINT.test(text) &&
    !FULL_PRICE_HINT.test(text)
  if (!isEquity) return resolved
  return { ...resolved, basis: 'equity', confidence: lowerConfidence(resolved.confidence, 'medium') }
}

export function normalizeRealEstateItem(rawItem: unknown, candidate: RealEstateCandidate): RealEstateFields | null {
  if (typeof rawItem !== 'object' || rawItem === null) return null
  const r = rawItem as Record<string, unknown>
  if (typeof r.property_type !== 'string' || typeof r.price_basis !== 'string') return null

  const listingType = oneOf(LISTING_TYPES, r.listing_type)
  const propertyType = oneOf(PROPERTY_TYPES, r.property_type) ?? 'other'
  const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is RealEstateTag => oneOf(RE_TAGS, t) !== null) : []
  const text = `${candidate.title} ${candidate.description ?? ''}`
  const { price, basis, confidence } = applyPasaloEquityBackstop(resolvePrice(r, listingType, candidate), tags, text)
  // Backstop 2 above.
  if (!tags.includes('room_share') && ROOM_SHARE_HINT.test(text)) tags.push('room_share')

  return {
    listing_type: listingType,
    property_type: propertyType,
    price_php: price,
    price_basis: basis,
    lot_sqm: boundedOrNull(r.lot_sqm, 1, 10_000_000),
    floor_sqm: boundedOrNull(r.floor_sqm, 1, 1_000_000),
    bedrooms: roomCount(r.bedrooms, propertyType === 'condo'),
    bathrooms: roomCount(r.bathrooms, false),
    project_name: stringOrNull(r.project_name, 120),
    area_text: normalizeNcrArea(stringOrNull(r.area_text, 100)),
    tags,
    confidence,
  }
}

export interface ParsedRealEstateResponse {
  fields: Map<string, RealEstateFields>
  // One log line per dropped item, in response order.
  skipped: string[]
}

// null when the response is not shaped like REAL_ESTATE_RESPONSE_SCHEMA at all.
export function parseRealEstateResponse(raw: unknown, batch: RealEstateCandidate[]): ParsedRealEstateResponse | null {
  const results = (raw as { results?: unknown } | undefined)?.results
  if (!Array.isArray(results)) return null
  const fields = new Map<string, RealEstateFields>()
  const skipped: string[] = []
  for (const item of results as { id?: unknown }[]) {
    const id = typeof item?.id === 'string' ? item.id : null
    const candidate = id === null ? undefined : batch.find((c) => c.id === id)
    if (!candidate) {
      skipped.push(`item ${id ?? '(missing id)'}: no matching candidate in this batch, skipping`)
      continue
    }
    const normalized = normalizeRealEstateItem(item, candidate)
    if (!normalized) {
      skipped.push(`item ${candidate.id}: malformed fields in Groq response, skipping`)
      continue
    }
    fields.set(candidate.id, normalized)
  }
  return { fields, skipped }
}
