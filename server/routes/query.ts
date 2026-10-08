import type { RouteHandler, RouteResult } from '../app'
import type { QueryClient } from '../../src/platform/storage'
import { getAllSettings, updateSettings } from '../../src/platform/settings'
import {
  getProductDetail,
  getProductsNeedingReview,
  getProductSummaries,
  getSoldCountsBySubCategory,
  getSubCategoryTree,
  markProductReviewed,
} from '../../src/modules/catalog'
import {
  getCollectKeywords,
  getListingDetail,
  getListingProductId,
  getSavedListings,
  replaceCollectKeywords,
  saveListing,
  unsaveListing,
} from '../../src/modules/collection'
import {
  getComparableListings,
  getDeals,
  excludeProductFromReview,
  getDiscountNotifications,
  getExcludedProducts,
  getExclusionSummary,
  includeInPricing,
  getPeerMedianPrice,
  getSoldComparablePrice,
  getUnreadDiscountNotificationCount,
  markAllDiscountNotificationsRead,
  markDiscountNotificationRead,
  setManualPrice,
} from '../../src/modules/pricing'
import { getRealEstateListings } from '../../src/modules/real-estate'

// The dashboard runs on Vercel and has no route to this box's Postgres, which
// listens on localhost only (deliberately - see the migration off Neon). This
// route is that path: the dashboard names a query, the server owns the SQL.
//
// Why a name registry rather than accepting SQL over the wire: createApp's
// bearer token is the only thing standing in front of this route, and a
// leaked token that could run arbitrary SQL would be full read/write on the
// database. With a registry the blast radius is exactly the queries the app
// already ships - no DROP, no exfiltration of tables the dashboard never
// reads. Args still reach the database, but only ever as bound parameters of
// a query the server ships, never as SQL text.
//
// Each feature module owns its dashboard queries and exports them from its
// index.ts; settings live in platform. Adding a dashboard query means adding
// it here too. That is the intended friction: it's the whole security
// boundary.
const REGISTRY = {
  getProductSummaries,
  getSubCategoryTree,
  getProductsNeedingReview,
  setManualPrice,
  markProductReviewed,
  excludeProductFromReview,
  includeInPricing,
  getExclusionSummary,
  getExcludedProducts,
  getProductDetail,
  getListingDetail,
  getSoldComparablePrice,
  getPeerMedianPrice,
  getComparableListings,
  getDeals,
  saveListing,
  unsaveListing,
  getSoldCountsBySubCategory,
  getSavedListings,
  getDiscountNotifications,
  getUnreadDiscountNotificationCount,
  markDiscountNotificationRead,
  markAllDiscountNotificationsRead,
  getAllSettings,
  updateSettings,
  getCollectKeywords,
  replaceCollectKeywords,
  getListingProductId,
  getRealEstateListings,
} satisfies Record<string, (db: QueryClient, ...args: never[]) => Promise<unknown>>

export type QueryName = keyof typeof REGISTRY

export const QUERY_NAMES = Object.keys(REGISTRY) as QueryName[]

interface QueryRequest {
  name: QueryName
  args: unknown[]
}

function parseBody(body: unknown): QueryRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const { name, args } = body as { name?: unknown; args?: unknown }
  if (typeof name !== 'string' || !(name in REGISTRY)) return null
  if (args !== undefined && !Array.isArray(args)) return null
  return { name: name as QueryName, args: (args as unknown[]) ?? [] }
}

export function createQueryHandler(db: QueryClient, log: (msg: string) => void = console.error): RouteHandler {
  return async (body: unknown): Promise<RouteResult> => {
    const request = parseBody(body)
    if (!request) {
      return { statusCode: 400, body: { error: 'unknown query or malformed body' } }
    }

    const fn = REGISTRY[request.name] as (db: QueryClient, ...args: unknown[]) => Promise<unknown>
    try {
      const result = await fn(db, ...request.args)
      return { statusCode: 200, body: { result } }
    } catch (err) {
      // Driver errors name real tables/columns - the dashboard gets a generic
      // failure, the detail stays in this box's log.
      log(`query ${request.name} failed: ${err instanceof Error ? err.message : String(err)}`)
      return { statusCode: 500, body: { error: 'query failed' } }
    }
  }
}
