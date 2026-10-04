import type { DbClient } from '../../platform/storage'
import { resolvePhotoUrls, toIsoOrNull, toNullableNumber } from '../../platform/rows'

export interface RealEstateFilters {
  listingType?: 'sale' | 'rent'
  propertyType?: string
  area?: string
  project?: string
  minPrice?: number
  maxPrice?: number
  minSqm?: number
  sort?: 'newest' | 'price_asc' | 'price_desc' | 'ppsqm_asc'
  view?: 'main' | 'review'
  includeRoomShares?: boolean
  limit?: number
  offset?: number
}

export interface RealEstateListing {
  id: string
  title: string
  primary_photo_url: string | null
  listed_at: string | null
  first_seen_at: string
  listed_price: number | null
  listing_type: 'sale' | 'rent' | null
  property_type: string
  price_php: number | null
  price_basis: string
  lot_sqm: number | null
  floor_sqm: number | null
  bedrooms: number | null
  bathrooms: number | null
  project_name: string | null
  area_text: string | null
  tags: string[]
  confidence: string
  price_per_sqm: number | null
  needs_review: boolean
}

const REAL_ESTATE_SORTS: Record<NonNullable<RealEstateFilters['sort']>, string> = {
  newest: 'COALESCE(x.listed_at, x.first_seen_at) DESC',
  price_asc: 'x.price_php ASC NULLS LAST',
  price_desc: 'x.price_php DESC NULLS LAST',
  ppsqm_asc: 'x.price_per_sqm ASC NULLS LAST',
}

const REAL_ESTATE_MAX_LIMIT = 100

// Active (not sold, not removed) listings that have extracted details. Price per
// sqm is computed here, never stored: a stored value goes stale when a recheck
// changes the price. Only sale listings priced as a total get one - it is
// meaningless for rent, per-sqm or equity prices. Filters are always bound
// parameters; the sort is a whitelist lookup, never interpolated user input.
//
// Main list = listings the extractor could resolve; review list = the ones it
// could not (price unresolved, low confidence, or sale/rent unclear). Room
// shares (a single room or bedspace) are hidden unless asked for - found in the
// 2026-09-25 spot check, they would otherwise drag condo rents down.
export async function getRealEstateListings(
  db: DbClient,
  filters: RealEstateFilters = {},
): Promise<RealEstateListing[]> {
  const where: string[] = []
  const params: unknown[] = []
  const add = (clause: string, value: unknown) => {
    params.push(value)
    where.push(clause.replace('?', `$${params.length}`))
  }
  if (filters.listingType) add('x.listing_type = ?', filters.listingType)
  if (filters.propertyType) add('x.property_type = ?', filters.propertyType)
  if (filters.area) add('x.area_text ILIKE ?', `%${filters.area}%`)
  if (filters.project) add('x.project_name ILIKE ?', `%${filters.project}%`)
  if (filters.minPrice !== undefined) add('x.price_php >= ?', filters.minPrice)
  if (filters.maxPrice !== undefined) add('x.price_php <= ?', filters.maxPrice)
  if (filters.minSqm !== undefined) add('COALESCE(x.lot_sqm, x.floor_sqm) >= ?', filters.minSqm)
  // Both literals come from boolean checks, never user input.
  where.push(`x.needs_review = ${filters.view === 'review'}`)
  if (!filters.includeRoomShares) where.push(`NOT x.tags ? 'room_share'`)

  const limit = Math.min(Math.max(filters.limit ?? 30, 1), REAL_ESTATE_MAX_LIMIT)
  const offset = Math.max(filters.offset ?? 0, 0)
  const orderBy = REAL_ESTATE_SORTS[filters.sort ?? 'newest'] ?? REAL_ESTATE_SORTS.newest
  params.push(limit, offset)

  const result = (await db.query(
    `SELECT * FROM (
       SELECT l.id, l.title, l.primary_photo_url, l.stored_photo_urls, l.listed_at, l.first_seen_at,
              l.price_amount AS listed_price,
              d.listing_type, d.property_type, d.price_php, d.price_basis, d.lot_sqm, d.floor_sqm,
              d.bedrooms, d.bathrooms, d.project_name, d.area_text, d.tags, d.confidence,
              CASE WHEN d.listing_type = 'sale' AND d.price_basis = 'total' AND d.price_php > 0 THEN
                d.price_php / NULLIF(CASE
                  WHEN d.property_type IN ('land', 'house_and_lot') THEN d.lot_sqm
                  WHEN d.property_type = 'condo' THEN d.floor_sqm
                  ELSE COALESCE(d.floor_sqm, d.lot_sqm) END, 0)
              END AS price_per_sqm,
              (d.price_basis = 'unresolved' OR d.confidence = 'low' OR d.listing_type IS NULL) AS needs_review
       FROM real_estate_details d
       JOIN listings l ON l.id = d.listing_id
       WHERE l.sold_at IS NULL AND l.flagged_removed_at IS NULL
     ) x
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderBy}, x.id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )) as { rows: Record<string, unknown>[] }
  return result.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    primary_photo_url: resolvePhotoUrls(r.stored_photo_urls, r.primary_photo_url)[0] ?? null,
    listed_at: toIsoOrNull(r.listed_at),
    first_seen_at: toIsoOrNull(r.first_seen_at) as string,
    listed_price: toNullableNumber(r.listed_price),
    listing_type: (r.listing_type as 'sale' | 'rent' | null) ?? null,
    property_type: r.property_type as string,
    price_php: toNullableNumber(r.price_php),
    price_basis: r.price_basis as string,
    lot_sqm: toNullableNumber(r.lot_sqm),
    floor_sqm: toNullableNumber(r.floor_sqm),
    bedrooms: (r.bedrooms as number | null) ?? null,
    bathrooms: (r.bathrooms as number | null) ?? null,
    project_name: (r.project_name as string | null) ?? null,
    area_text: (r.area_text as string | null) ?? null,
    tags: (r.tags as string[] | null) ?? [],
    confidence: r.confidence as string,
    price_per_sqm: toNullableNumber(r.price_per_sqm),
    needs_review: r.needs_review === true,
  }))
}
