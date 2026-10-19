import type { DbClient, QueryClient } from '../../../platform/storage'
import { resolvePhotoUrls, toIsoOrNull } from '../../../platform/rows'
import { DEFAULT_DISCOUNT_POLICY } from '../domain/discount-policy'
import type { DiscountVerificationCandidate, NewDiscountNotification } from '../types'

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
// app/discount-notifications.ts) right after a listing first
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

// One multi-row statement, so a batch's notifications land all or nothing.
// ON CONFLICT (listing_id) DO NOTHING enforces "at most one notification per
// listing ever", so re-inserting a decided notification is a no-op.
export async function insertDiscountNotifications(
  db: DbClient,
  notifications: NewDiscountNotification[],
): Promise<void> {
  if (notifications.length === 0) return

  const valuesSql = notifications
    .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
    .join(', ')
  const params = notifications.flatMap((n) => [n.listingId, n.productId, n.discountPercent, n.referencePrice])

  await db.query(
    `INSERT INTO discount_notifications (listing_id, product_id, discount_percent, reference_price)
     VALUES ${valuesSql}
     ON CONFLICT (listing_id) DO NOTHING`,
    params,
  )
}

// Pending = verified_at IS NULL. Backoff (1hr) on last_verification_attempt_at
// keeps a candidate stuck on a transient failure (network blip, all 3 price
// providers down at once) from re-burning a paid Tavily/Exa call every
// verify-discount-notifications.ts loop tick (every 5 min). Oldest-flagged
// first, same "work down the backlog in order" idiom as getCheckListingsCandidates.
// Excludes a candidate whose product has no enrichment judgment yet UNLESS
// its price already fails minPricePesos - that gate needs no enrichment
// data at all (precheckDiscountCandidate checks it first), so it still
// resolves for free/instantly. Everything else waiting on real enrichment
// is left alone entirely: not fetched, not attempted, no log noise, no
// last_verification_attempt_at write - it'll show up here on its own the
// moment enrich-products actually judges it (per direct instruction,
// 2026-08-31: "don't process it at all since enrichment is still pending").
// minPricePesos must be kept in sync with whatever precheckDiscountCandidate
// is using this lap - the caller (verify-discount-notifications) loads both
// from the same settings read to guarantee that.
export async function getUnverifiedDiscountCandidates(
  db: DbClient,
  limit: number,
  minPricePesos: number = DEFAULT_DISCOUNT_POLICY.minPricePesos,
): Promise<DiscountVerificationCandidate[]> {
  const result = (await db.query(
    `SELECT dn.id, dn.listing_id, l.title, l.description, l.condition, l.price_amount,
            p.base_model, pe.is_specific_product
     FROM discount_notifications dn
     JOIN listings l ON l.id = dn.listing_id
     JOIN products p ON p.id = dn.product_id
     LEFT JOIN product_enrichment pe ON pe.product_id = dn.product_id
     WHERE dn.verified_at IS NULL
       AND (dn.last_verification_attempt_at IS NULL OR dn.last_verification_attempt_at < now() - interval '1 hour')
       AND (pe.is_specific_product IS NOT NULL OR l.price_amount < $2)
     ORDER BY dn.created_at ASC
     LIMIT $1`,
    [limit, minPricePesos],
  )) as { rows: Record<string, unknown>[] }
  return result.rows.map((r) => ({
    id: Number(r.id),
    listing_id: r.listing_id as string,
    title: r.title as string | null,
    description: r.description as string | null,
    condition: r.condition as string | null,
    price_amount: Number(r.price_amount),
    base_model: r.base_model as string,
    is_specific_product: r.is_specific_product as boolean | null,
  }))
}

export interface DiscountVerificationOutcome {
  discountPercent: number
  referencePrice: number
  source: string
  reasoning: string
}

// discount_percent/reference_price are overwritten with the fresh verified
// numbers, not left as the original stale-median detection values - the
// dashboard should show what verification actually confirmed, same
// transparency as listing_price_review overwriting the displayed price.
export async function markDiscountNotificationVerified(
  db: DbClient,
  id: number,
  data: DiscountVerificationOutcome,
): Promise<void> {
  await db.query(
    `UPDATE discount_notifications
     SET verified_at = now(), discount_percent = $2, reference_price = $3,
         verification_source = $4, verification_reasoning = $5
     WHERE id = $1`,
    [id, data.discountPercent, data.referencePrice, data.source, data.reasoning],
  )
}

// A definitive rejection (any check says no) deletes the row outright rather
// than flagging a status - each listing only ever gets one candidate row
// ever (see the table's UNIQUE(listing_id)), so there's nothing to leave a
// tombstone for, and this doubles as "never notify, never retry."
export async function rejectDiscountNotification(db: DbClient, id: number): Promise<void> {
  await db.query(`DELETE FROM discount_notifications WHERE id = $1`, [id])
}

// A transient failure (all price providers/Groq errored) - stays pending,
// only the attempt timestamp moves, so getUnverifiedDiscountCandidates'
// backoff window kicks in for this row without ever marking it verified.
export async function markDiscountNotificationAttempted(db: DbClient, id: number): Promise<void> {
  await db.query(`UPDATE discount_notifications SET last_verification_attempt_at = now() WHERE id = $1`, [id])
}
