import type { RouteHandler, RouteResult } from '../app'
import type { QueryClient } from '../queries'
import * as queries from '../queries'
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
// a query written here, never as SQL text.
//
// Adding a dashboard query means adding it here too. That is the intended
// friction: it's the whole security boundary.
const REGISTRY = {
  getProductSummaries: queries.getProductSummaries,
  getSubCategoryTree: queries.getSubCategoryTree,
  getProductsNeedingReview: queries.getProductsNeedingReview,
  setManualPrice: queries.setManualPrice,
  markProductReviewed: queries.markProductReviewed,
  excludeProductFromReview: queries.excludeProductFromReview,
  getProductDetail: queries.getProductDetail,
  getListingDetail: queries.getListingDetail,
  getSoldComparablePrice: queries.getSoldComparablePrice,
  getPeerMedianPrice: queries.getPeerMedianPrice,
  getComparableListings: queries.getComparableListings,
  getDeals: queries.getDeals,
  saveListing: queries.saveListing,
  unsaveListing: queries.unsaveListing,
  getSoldCountsBySubCategory: queries.getSoldCountsBySubCategory,
  getSavedListings: queries.getSavedListings,
  getDiscountNotifications: queries.getDiscountNotifications,
  getUnreadDiscountNotificationCount: queries.getUnreadDiscountNotificationCount,
  markDiscountNotificationRead: queries.markDiscountNotificationRead,
  markAllDiscountNotificationsRead: queries.markAllDiscountNotificationsRead,
  getAllSettings: queries.getAllSettings,
  updateSettings: queries.updateSettings,
  getCollectKeywords: queries.getCollectKeywords,
  replaceCollectKeywords: queries.replaceCollectKeywords,
  getListingProductId: queries.getListingProductId,
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
