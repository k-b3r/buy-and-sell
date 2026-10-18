import { z } from 'zod'

// Request parsing for the catalog routes. Input is Express's req.query (a
// repeated param arrives as an array, a single one as a string) or a path
// param, so every field is normalised here and routes.ts only sees clean data.

const first = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value)
const many = (value: unknown): unknown => (value === undefined ? [] : Array.isArray(value) ? value : [value])

const offsetSchema = z.preprocess(
  first,
  z
    .string()
    .regex(/^\d+$/, 'offset must be a non-negative integer')
    .optional()
    .transform((raw) => (raw === undefined ? 0 : Number(raw))),
)

/** GET /products: search text, category and sub-category filters, paging offset. */
export const productListQuerySchema = z
  .object({
    q: z.preprocess(first, z.string().optional()),
    category: z.preprocess(many, z.array(z.string())),
    subCategory: z.preprocess(many, z.array(z.string())),
    offset: offsetSchema,
  })
  .transform(({ q, category, subCategory, offset }) => ({
    search: q,
    categories: category,
    subCategories: subCategory,
    offset,
  }))

const LISTING_SORT_KEYS = [
  'discount_desc',
  'discount_asc',
  'price_asc',
  'price_desc',
  'listed_newest',
  'listed_oldest',
] as const
export type ListingSortKey = (typeof LISTING_SORT_KEYS)[number]

const LISTED_WITHIN_DAYS = [0, 7, 30, 90]

export interface ListingsFilters {
  sortKey: ListingSortKey
  listedWithinDays: number
  hideSold: boolean
  negotiableOnly: boolean
  selectedBand: number | null
}

const optionalString = z.preprocess(first, z.string().optional())

/**
 * GET /products/:id/listings query. Filter params are lenient on purpose (an
 * unknown value falls back to its default, same as the dashboard's
 * parseListingsFilters did): only the paging offset can fail.
 */
export const listingsQuerySchema = z
  .object({
    sort: optionalString,
    listedWithin: optionalString,
    hideSold: optionalString,
    negotiable: optionalString,
    band: optionalString,
    offset: offsetSchema,
  })
  .transform(({ sort, listedWithin, hideSold, negotiable, band, offset }) => {
    const bandNumber = band === undefined ? NaN : Number(band)
    const within = Number(listedWithin)
    const filters: ListingsFilters = {
      sortKey: LISTING_SORT_KEYS.find((key) => key === sort) ?? 'discount_desc',
      listedWithinDays: LISTED_WITHIN_DAYS.includes(within) ? within : 0,
      hideSold: hideSold === undefined ? true : hideSold === '1',
      negotiableOnly: negotiable === '1',
      selectedBand: Number.isFinite(bandNumber) ? bandNumber : null,
    }
    return { filters, offset }
  })
