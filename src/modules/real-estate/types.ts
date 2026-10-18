// Types and ports shared by this module's own files. Row types stay in store/.

export type PropertyType = 'house_and_lot' | 'condo' | 'land' | 'commercial' | 'other'
export type ListingType = 'sale' | 'rent'
export type PriceBasis = 'total' | 'per_sqm' | 'monthly' | 'equity' | 'unresolved'
export type RealEstateConfidence = 'high' | 'medium' | 'low'
export type RealEstateTag = 'pasalo' | 'foreclosure' | 'rfo' | 'preselling' | 'has_title' | 'furnished' | 'room_share'

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

// The I/O port this module needs from an LLM client; a Groq pool satisfies it.
export interface JsonModelClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
}

// The listing's price before a refresh, as returned by the refresh UPDATE.
export interface PriorPriceRow {
  old_price_amount: string | number | null
  old_price_currency: string | null
  old_first_seen_at: string | Date
}
