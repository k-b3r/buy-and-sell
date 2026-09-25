import type { RealEstateFilters, RealEstateListing } from './queries'

// Types-only import from queries.ts, so this module is safe in client components.

export const NCR_AREAS = [
  'Caloocan', 'Las Piñas', 'Makati', 'Malabon', 'Mandaluyong', 'Manila', 'Marikina', 'Muntinlupa', 'Navotas',
  'Parañaque', 'Pasay', 'Pasig', 'Pateros', 'Quezon City', 'San Juan', 'Taguig', 'Valenzuela',
] as const

export const PROPERTY_TYPE_LABELS: Record<string, string> = {
  house_and_lot: 'House & lot',
  condo: 'Condo',
  land: 'Land',
  commercial: 'Commercial',
  other: 'Other',
}

export const REAL_ESTATE_PAGE_SIZE = 30

const SORTS = ['newest', 'price_asc', 'price_desc', 'ppsqm_asc'] as const

function positiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function parseRealEstateFilters(params: Record<string, string | undefined>): { filters: RealEstateFilters; page: number } {
  const pageNumber = Number(params.page)
  const page = Number.isInteger(pageNumber) && pageNumber >= 1 ? pageNumber : 1
  const filters: RealEstateFilters = {
    limit: REAL_ESTATE_PAGE_SIZE,
    offset: (page - 1) * REAL_ESTATE_PAGE_SIZE,
  }
  if (params.kind === 'sale' || params.kind === 'rent') filters.listingType = params.kind
  if (params.type && params.type in PROPERTY_TYPE_LABELS) filters.propertyType = params.type
  if (params.area?.trim()) filters.area = params.area.trim()
  if (params.project?.trim()) filters.project = params.project.trim()
  const min = positiveNumber(params.min)
  const max = positiveNumber(params.max)
  const sqm = positiveNumber(params.sqm)
  if (min !== undefined) filters.minPrice = min
  if (max !== undefined) filters.maxPrice = max
  if (sqm !== undefined) filters.minSqm = sqm
  if (params.sort && (SORTS as readonly string[]).includes(params.sort)) filters.sort = params.sort as RealEstateFilters['sort']
  if (params.view === 'review') filters.view = 'review'
  if (params.rooms === '1') filters.includeRoomShares = true
  return { filters, page }
}

const peso = (n: number) => `₱${n.toLocaleString('en-US')}`

export function formatPrice(l: RealEstateListing): string {
  if (l.price_php === null || l.price_basis === 'unresolved') {
    return l.listed_price !== null ? `Price unclear (listed as ${peso(l.listed_price)})` : 'Price not stated'
  }
  if (l.price_basis === 'monthly') return `${peso(l.price_php)} / month`
  if (l.price_basis === 'per_sqm') return `${peso(l.price_php)} / sqm`
  if (l.price_basis === 'equity') return `${peso(l.price_php)} equity`
  return peso(l.price_php)
}

export function formatAreaLine(l: RealEstateListing): string {
  const parts: string[] = []
  if (l.lot_sqm !== null) parts.push(`${l.lot_sqm} sqm lot`)
  if (l.floor_sqm !== null) parts.push(`${l.floor_sqm} sqm floor`)
  if (l.bedrooms === 0) parts.push('Studio')
  else if (l.bedrooms !== null) parts.push(`${l.bedrooms} BR`)
  if (l.bathrooms !== null) parts.push(`${l.bathrooms} BA`)
  return parts.join(' · ')
}

// Mirrors the needs_review rule in server/queries.ts (price unresolved, low
// confidence, or sale/rent unclear).
export function formatReviewReason(l: RealEstateListing): string {
  const reasons: string[] = []
  if (l.price_basis === 'unresolved') reasons.push('price not stated')
  if (l.listing_type === null) reasons.push('sale or rent unclear')
  if (l.confidence === 'low') reasons.push('low confidence')
  return reasons.join(', ')
}

// Query string for one page of results, used by the infinite-scroll grid to ask
// /api/real-estate for the next page with the same filters.
export function realEstatePageQuery(params: Record<string, string | undefined>, page: number): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v && k !== 'page') q.set(k, v)
  q.set('page', String(page))
  return q.toString()
}
