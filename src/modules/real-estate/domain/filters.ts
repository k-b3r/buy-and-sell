import type { PropertyType, RealEstateSort } from '../types'

// The filter vocabulary the real-estate page and its API share. Kept out of
// schemas.ts (the HTTP edge) because the dashboard reads the same lists through
// scripts/gen-dashboard-shared.ts; one definition stops the two drifting.

/** One page of the real-estate grid. */
export const REAL_ESTATE_PAGE_SIZE = 30

/** Property types the filter accepts, in the order the page offers them. */
export const REAL_ESTATE_PROPERTY_TYPES = [
  'house_and_lot',
  'condo',
  'land',
  'commercial',
  'other',
] as const satisfies readonly PropertyType[]

/** Sort keys the filter accepts, in the order the page offers them. */
export const REAL_ESTATE_SORTS = [
  'newest',
  'price_asc',
  'price_desc',
  'ppsqm_asc',
] as const satisfies readonly RealEstateSort[]
