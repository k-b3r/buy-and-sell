import { z } from 'zod'
import type { RealEstateFilters } from './types'

export const REAL_ESTATE_PAGE_SIZE = 30

const PROPERTY_TYPES = ['house_and_lot', 'condo', 'land', 'commercial', 'other']
const SORTS = ['newest', 'price_asc', 'price_desc', 'ppsqm_asc'] as const
const TEXT_FILTERS = ['area', 'project'] as const
// URL param -> filter field.
const NUMBER_FILTERS = [
  ['min', 'minPrice'],
  ['max', 'maxPrice'],
  ['sqm', 'minSqm'],
] as const

function nonNegativeNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

type RealEstateQuery = Partial<
  Record<'kind' | 'type' | 'area' | 'project' | 'min' | 'max' | 'sqm' | 'sort' | 'view' | 'rooms' | 'page', string>
>

// Text and number filters, split out of realEstateQuerySchema's transform to keep its complexity down.
function applyTextAndNumberFilters(q: RealEstateQuery, filters: RealEstateFilters): void {
  for (const key of TEXT_FILTERS) {
    const text = q[key]?.trim()
    if (text) filters[key] = text
  }
  for (const [param, key] of NUMBER_FILTERS) {
    const value = nonNegativeNumber(q[param])
    if (value !== undefined) filters[key] = value
  }
}

// Query string of GET /real-estate, i.e. the /real-estate page's own URL
// params (the grid's infinite scroll passes them straight through). A value
// the dashboard's parseRealEstateFilters ignored (unknown kind, junk number,
// blank text) is still ignored here so today's URLs keep working; the request
// fails only when the shape is wrong (a repeated param arrives as an array and
// is rejected).
export const realEstateQuerySchema = z
  .object({
    kind: z.string().optional(),
    type: z.string().optional(),
    area: z.string().optional(),
    project: z.string().optional(),
    min: z.string().optional(),
    max: z.string().optional(),
    sqm: z.string().optional(),
    sort: z.string().optional(),
    view: z.string().optional(),
    rooms: z.string().optional(),
    page: z.string().optional(),
  })
  .transform((q): { filters: RealEstateFilters; page: number } => {
    const n = Number(q.page)
    const page = Number.isInteger(n) && n >= 1 ? n : 1
    const filters: RealEstateFilters = {
      limit: REAL_ESTATE_PAGE_SIZE,
      offset: (page - 1) * REAL_ESTATE_PAGE_SIZE,
    }
    if (q.kind === 'sale' || q.kind === 'rent') filters.listingType = q.kind
    if (q.type && PROPERTY_TYPES.includes(q.type)) filters.propertyType = q.type
    applyTextAndNumberFilters(q, filters)
    if (q.sort && (SORTS as readonly string[]).includes(q.sort)) filters.sort = q.sort as RealEstateFilters['sort']
    if (q.view === 'review') filters.view = 'review'
    if (q.rooms === '1') filters.includeRoomShares = true
    return { filters, page }
  })
