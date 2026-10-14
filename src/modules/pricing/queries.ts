import type { QueryClient } from '../../platform/storage'
import { resolvePhotoUrls, toIsoOrNull } from '../../platform/rows'
import { LOOKUP_OUTCOME_REASONS } from './exclusion'

export interface DiscountNotification {
  id: number
  listing_id: string
  product_id: number
  title: string | null
  primary_photo_url: string | null
  discount_percent: number
  reference_price: number
  created_at: string
  read_at: string | null
  verification_reasoning: string | null
}

// Written by the root pipeline's detectAndRecordDiscountNotifications (see
// discount-notifications.ts) right after a listing first
// gets a product_id - not queried live here, just displayed. Not cached by
// the server's routes: a bell badge showing a stale count defeats the point,
// and this table is small/indexed enough that a plain read is cheap.
export async function getDiscountNotifications(db: QueryClient, limit = 20): Promise<DiscountNotification[]> {
  const result = await db.query(
    `SELECT dn.id, dn.listing_id, dn.product_id, l.title, l.primary_photo_url, l.stored_photo_urls,
            dn.discount_percent, dn.reference_price, dn.created_at, dn.read_at, dn.verification_reasoning
     FROM discount_notifications dn
     JOIN listings l ON l.id = dn.listing_id
     WHERE dn.verified_at IS NOT NULL
     ORDER BY dn.created_at DESC
     LIMIT $1`,
    [limit],
  )
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    listing_id: r.listing_id as string,
    product_id: Number(r.product_id),
    title: r.title as string | null,
    primary_photo_url: resolvePhotoUrls(r.stored_photo_urls, r.primary_photo_url)[0] ?? null,
    discount_percent: Number(r.discount_percent),
    reference_price: Number(r.reference_price),
    created_at: toIsoOrNull(r.created_at) as string,
    read_at: toIsoOrNull(r.read_at),
    verification_reasoning: r.verification_reasoning as string | null,
  }))
}

export async function getUnreadDiscountNotificationCount(db: QueryClient): Promise<number> {
  const result = await db.query(
    `SELECT count(*) AS count FROM discount_notifications WHERE read_at IS NULL AND verified_at IS NOT NULL`,
    [],
  )
  return Number((result.rows as { count: string }[])[0].count)
}

export async function markDiscountNotificationRead(db: QueryClient, id: number): Promise<void> {
  await db.query(`UPDATE discount_notifications SET read_at = now() WHERE id = $1 AND read_at IS NULL`, [id])
}

export async function markAllDiscountNotificationsRead(db: QueryClient): Promise<void> {
  await db.query(`UPDATE discount_notifications SET read_at = now() WHERE read_at IS NULL`, [])
}

export interface ExclusionReasonCount {
  reason: string
  count: number
  // true: a failed price search, so including the product retries the lookup.
  retry: boolean
}

// Excluded view's reason groups, biggest first.
export async function getExclusionSummary(db: QueryClient): Promise<ExclusionReasonCount[]> {
  const result = (await db.query(
    `SELECT COALESCE(price_lookup_excluded_reason, 'unknown') AS reason, count(*)::int AS count,
            COALESCE(price_lookup_excluded_reason = ANY($1), false) AS retry
     FROM products WHERE price_lookup_excluded
     GROUP BY 1, 3 ORDER BY 2 DESC, 1`,
    [[...LOOKUP_OUTCOME_REASONS]],
  )) as { rows: ExclusionReasonCount[] }
  return result.rows
}

export interface ExcludedProduct {
  id: number
  base_model: string
  variant_tier: string | null
  listing_count: number
}

const EXCLUDED_PAGE_SIZE = 50

// One reason's excluded products, most listings first: the ones whose
// missing price hides the most.
export async function getExcludedProducts(
  db: QueryClient,
  reason: string,
  options: { offset?: number; limit?: number } = {},
): Promise<ExcludedProduct[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, count(l.id)::int AS listing_count
     FROM products p LEFT JOIN listings l ON l.product_id = p.id
     WHERE p.price_lookup_excluded AND COALESCE(p.price_lookup_excluded_reason, 'unknown') = $1
     GROUP BY p.id ORDER BY listing_count DESC, p.base_model
     LIMIT $2 OFFSET $3`,
    [reason, options.limit ?? EXCLUDED_PAGE_SIZE, options.offset ?? 0],
  )) as { rows: ExcludedProduct[] }
  return result.rows
}
