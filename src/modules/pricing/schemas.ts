import { z } from 'zod'
import { positiveIntIdSchema } from '../../platform/positive-int-id'
import { DEALS_CONFIDENCE_TIERS } from './domain/deals'
import type { DealsConfidenceTier } from './types'
import { PRICE_EXCLUSION_REASONS } from './domain/exclusion-reasons'

// Request parsing for the pricing routes. Query input is Express's req.query
// (a repeated param arrives as an array, a single one as a string), so every
// field is normalised here and routes.ts only sees clean data.

const first = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value)
const many = (value: unknown): unknown => (value === undefined ? [] : Array.isArray(value) ? value : [value])
const optionalString = z.preprocess(first, z.string().optional())

const MAX_EXCLUDED_PAGE_SIZE = 200

/** Reasons a product can be excluded from price lookup (the exclusion table's vocabulary). */
export const priceExclusionReasonSchema = z.enum(PRICE_EXCLUSION_REASONS)

/**
 * A human-entered price range for a needs_review product. Messages are what
 * the dashboard has always shown for each failure; checks run in this order.
 */
export const manualPriceSchema = z
  .object({
    kind: z.enum(['new', 'secondhand'], { error: 'kind must be "new" or "secondhand"' }),
    priceLow: z.number({ error: 'priceLow/priceHigh must be numbers' }),
    priceHigh: z.number({ error: 'priceLow/priceHigh must be numbers' }),
  })
  .refine((p) => p.priceLow > 0 && p.priceHigh > 0 && p.priceLow <= p.priceHigh, {
    message: 'priceLow must be positive and not greater than priceHigh',
  })

export type ManualPrice = z.infer<typeof manualPriceSchema>

/** Notification id path param: the shared positive-integer id schema. */
export const notificationIdParamSchema = positiveIntIdSchema

const offsetSchema = z.preprocess(
  first,
  z
    .string()
    .regex(/^\d+$/, 'offset must be a non-negative integer')
    .optional()
    .transform((raw) => (raw === undefined ? 0 : Number(raw))),
)

// An empty param counts as absent, anything else must be a number.
function optionalNumber(raw: string | undefined, name: string, ctx: z.RefinementCtx): number | undefined {
  if (!raw) return undefined
  const value = Number(raw)
  if (Number.isNaN(value)) {
    ctx.issues.push({ code: 'custom', message: `${name} must be a number`, input: raw })
    return undefined
  }
  return value
}

/**
 * GET /deals query. minTier and addedWithinHours are lenient on purpose (an
 * unknown tier or a non-positive hour count is ignored, as the dashboard's
 * handler did); a malformed number or offset fails the request.
 */
export const dealsQuerySchema = z
  .object({
    search: optionalString,
    category: z.preprocess(many, z.array(z.string())),
    minProfit: optionalString,
    minTier: optionalString,
    maxDaysListed: optionalString,
    addedWithinHours: optionalString,
    soldOnly: optionalString,
    lowConfidence: optionalString,
    offset: offsetSchema,
  })
  .transform((q, ctx) => {
    const hours = Number(q.addedWithinHours)
    const filters = {
      search: q.search || undefined,
      categories: q.category.length > 0 ? q.category : undefined,
      minProfitPesos: optionalNumber(q.minProfit, 'minProfit', ctx),
      minConfidenceTier: DEALS_CONFIDENCE_TIERS.find((tier): tier is DealsConfidenceTier => tier === q.minTier),
      maxDaysListed: optionalNumber(q.maxDaysListed, 'maxDaysListed', ctx),
      addedWithinHours: Number.isInteger(hours) && hours > 0 ? hours : undefined,
      soldOnly: q.soldOnly === 'true',
      lowConfidenceOnly: q.lowConfidence === 'true',
    }
    return { filters, offset: q.offset }
  })

/** GET /price-exclusions query: one reason's excluded products, paged. */
export const excludedProductsQuerySchema = z.object({
  reason: z.string({ error: 'reason is required' }).min(1, 'reason is required'),
  offset: offsetSchema,
  limit: z.preprocess(
    first,
    z
      .string()
      .regex(/^[1-9]\d*$/, 'limit must be a positive integer')
      .transform(Number)
      .pipe(z.number().max(MAX_EXCLUDED_PAGE_SIZE, `limit must be at most ${MAX_EXCLUDED_PAGE_SIZE}`))
      .optional(),
  ),
})
