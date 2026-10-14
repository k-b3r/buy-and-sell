import express from 'express'
import type { Response, Router } from 'express'
import type { z } from 'zod'
import { getAllSettings } from '../../platform/settings'
import type { QueryClient } from '../../platform/storage'
import { markProductReviewed, productIdParamSchema } from '../catalog'
import { getDeals } from './deals'
import { excludeProductFromReview, includeInPricing } from './exclusion'
import {
  getDiscountNotifications,
  getExcludedProducts,
  getExclusionSummary,
  getUnreadDiscountNotificationCount,
  markAllDiscountNotificationsRead,
  markDiscountNotificationRead,
  setManualPrice,
} from './queries'
import { dealsQuerySchema, excludedProductsQuerySchema, manualPriceSchema, notificationIdParamSchema } from './schemas'

// HTTP edge of the pricing feature, mounted by server/index.ts only (the
// module's index.ts does not export it, so workers never load express).
// Same contract the dashboard's /api/deals, /api/notifications and
// /api/products/:id/{exclude,include,manual-price} handlers had.

// Mutations drop the catalog's cached reads (products-list, product:ID,
// needs-review: the tags catalog/routes.ts wraps its reads in). The slice of
// server/cache.ts this router uses; declared here because src/modules never
// import from server/.
export interface CacheInvalidator {
  invalidate(...tags: string[]): void
}

const DEALS_PAGE_SIZE = 30
const EXCLUSIONS_UI_SETTING = 'pricing.exclusions_ui_enabled'
// Fallbacks if the settings table lacks the keys (the Settings page edits them).
const DEFAULT_MIN_PROFIT_PESOS = 1000
const DEFAULT_MIN_PRICE_PESOS = 500

function badRequest(res: Response, issues: z.core.$ZodIssue[]): void {
  res.status(400).json({ error: issues[0].message, issues })
}

export function createPricingRouter(db: QueryClient, cache: CacheInvalidator): Router {
  const router = express.Router()

  // Live discount_policy.* settings, not DEFAULT_DISCOUNT_POLICY: an operator
  // edit on the Settings page takes effect without a redeploy.
  router.get('/deals', async (req, res) => {
    const query = dealsQuerySchema.safeParse(req.query)
    if (!query.success) return badRequest(res, query.error.issues)
    const { filters, offset } = query.data

    const byKey = new Map((await getAllSettings(db)).map((s) => [s.key, s.value]))
    const discountPolicy = {
      minProfitPesos: byKey.get('discount_policy.min_profit_pesos') ?? DEFAULT_MIN_PROFIT_PESOS,
      minPricePesos: byKey.get('discount_policy.min_price_pesos') ?? DEFAULT_MIN_PRICE_PESOS,
    }
    const deals = await getDeals(db, discountPolicy, { ...filters, offset, limit: DEALS_PAGE_SIZE })
    const nextOffset = deals.length === DEALS_PAGE_SIZE ? offset + DEALS_PAGE_SIZE : null
    res.json({ deals, nextOffset })
  })

  // Uncached on purpose: a bell badge showing a stale count defeats the point.
  router.get('/notifications', async (_req, res) => {
    const [notifications, unreadCount] = await Promise.all([
      getDiscountNotifications(db),
      getUnreadDiscountNotificationCount(db),
    ])
    res.json({ notifications, unreadCount })
  })

  router.post('/notifications/mark-all-read', async (_req, res) => {
    await markAllDiscountNotificationsRead(db)
    res.json({ ok: true })
  })

  router.post('/notifications/:id/read', async (req, res) => {
    const id = notificationIdParamSchema.safeParse(req.params.id)
    if (!id.success) return badRequest(res, id.error.issues)
    await markDiscountNotificationRead(db, id.data)
    res.json({ ok: true })
  })

  router.get('/price-exclusions/summary', async (_req, res) => {
    res.json({ summary: await getExclusionSummary(db) })
  })

  router.get('/price-exclusions', async (req, res) => {
    const query = excludedProductsQuerySchema.safeParse(req.query)
    if (!query.success) return badRequest(res, query.error.issues)
    const { reason, offset, limit } = query.data
    res.json({ products: await getExcludedProducts(db, reason, { offset, limit }) })
  })

  // A human agrees with the low-confidence hunch that this needs_review
  // product isn't a real priceable product (see exclusion.ts).
  router.post('/products/:id/exclude', async (req, res) => {
    const id = productIdParamSchema.safeParse(req.params.id)
    if (!id.success) return badRequest(res, id.error.issues)
    await excludeProductFromReview(db, id.data, 'manual_review')
    cache.invalidate('needs-review', 'products-list', `product:${id.data}`)
    res.json({ ok: true })
  })

  // The undo for a pricing exclusion (BUY-36); hidden while the exclusions UI
  // setting is off, same as the page that calls it.
  router.post('/products/:id/include', async (req, res) => {
    const settings = await getAllSettings(db)
    if (!settings.some((s) => s.key === EXCLUSIONS_UI_SETTING && s.value === 1)) {
      res.status(404).json({ error: 'disabled' })
      return
    }
    const id = productIdParamSchema.safeParse(req.params.id)
    if (!id.success) return badRequest(res, id.error.issues)
    await includeInPricing(db, id.data)
    cache.invalidate('products-list', `product:${id.data}`)
    res.json({ ok: true })
  })

  // Providing a price is itself the human review the needs-review page exists
  // for, so it also clears the review flag (one click, not two).
  router.post('/products/:id/manual-price', async (req, res) => {
    const id = productIdParamSchema.safeParse(req.params.id)
    if (!id.success) return badRequest(res, id.error.issues)
    const price = manualPriceSchema.safeParse(req.body ?? {})
    if (!price.success) return badRequest(res, price.error.issues)
    await setManualPrice(db, id.data, price.data)
    await markProductReviewed(db, id.data)
    cache.invalidate('needs-review', 'products-list', `product:${id.data}`)
    res.json({ ok: true })
  })

  return router
}
