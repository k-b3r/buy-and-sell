import type { DbClient } from '../../platform/storage'
import type { PriceRange } from './price-lookup'
import { isJunkPrice, isMagnitudeOutlier } from './clean-median'
import { getProductCleanMedian } from './queries'
import { isNewCondition } from './price-rules'

export interface DiscountPolicyThresholds {
  highDiscountThresholdPercent: number
  minProfitPesos: number
  minPricePesos: number
}

// Operator-tunable via the dashboard Settings page (discount_policy.* keys,
// src/platform/settings.ts) - callers load live values with loadSettings
// and pass them through explicitly; these are just the fallback defaults
// (also the settings table's seed values, db/schema.sql) for callers that
// don't pass thresholds at all (e.g. direct test calls).
export const DEFAULT_DISCOUNT_POLICY: DiscountPolicyThresholds = {
  // Bar for a bell-worthy notification, deliberately higher than the
  // dashboard's 10% discount-badge floor (DISCOUNT_SUMMARY_LATERAL) - a
  // notification is a stronger claim than a badge, per direct instruction.
  highDiscountThresholdPercent: 30,
  // A high % on a cheap item isn't a meaningful opportunity (₱150 item at
  // 50% off is only ₱75 profit) - the absolute peso gap must also clear
  // this bar, independent of the percent threshold.
  minProfitPesos: 1000,
  // Below this, the item isn't worth chasing regardless of discount%/profit
  // math - also the regime where a vague base_model (Bikini, Books, Boys'
  // Clothes) gets matched against a wildly wrong reference price and
  // produces a noisy, not-actually-real "deal" (confirmed live 2026-08-31:
  // several ₱50-150 listings cleared both the discount% and profit bars on
  // stale reference prices alone). Deliberately well below minProfitPesos's
  // own ₱1,000 bar, not equal to it - a ₱500 item reselling at ₱1,500 is a
  // real ₱1,000-profit flip and shouldn't be excluded just for being cheap
  // up front; this floor exists to catch junk-tier noise, not to require
  // the item itself be expensive.
  minPricePesos: 500,
}

// decideListingDiscount's fallback reference when real secondhand market data
// isn't available yet: the clean median over ALL this product's listings,
// sold and active alike (unlike the deals page's active-only peer median).
// null when there aren't at least 2 comparable listings.
const DISCOUNT_PEER_MIN_SAMPLE = 2

async function getDiscountPeerMedian(db: DbClient, productId: number): Promise<number | null> {
  const median = await getProductCleanMedian(db, productId, { scope: 'all', minSample: DISCOUNT_PEER_MIN_SAMPLE })
  return median?.medianPrice ?? null
}

export interface DiscountCheckListing {
  id: string
  productId: number
  condition: string | null
  priceAmount: number | null
}

export interface DiscountNotification {
  listingId: string
  productId: number
  discountPercent: number
  referencePrice: number
}

// Real-market-price-first discount decision for a single listing, made in
// catalog/run-extraction.ts right after its product has (or already had)
// retail/secondhand pricing ensured - the "trigger is retail pricing
// becoming available" design (2026-08-31), replacing the old
// batch-of-siblings-only check that could never fire on a product's first
// listing. Reads only; returns the notification to insert, or null when the
// listing doesn't qualify. Split from insertDiscountNotifications so the
// caller can decide before its batch's product_ids are saved (peer median
// then excludes the batch's own listings) and insert only after the save.
//
// Priority: secondhand (real market data) for any non-"New" listing - only
// falls back to peer-comparison (median of this product's own listings)
// when secondhand isn't available yet. "New" listings always compare
// against retail; a "New" listing is never passed here without a retail
// price already in hand (see ensureProductPriced's exclude-on-retail-miss
// behavior - a product with no retail was already excluded before this
// function would ever be called).
export async function decideListingDiscount(
  db: DbClient,
  listing: DiscountCheckListing,
  pricing: { retail: PriceRange | null; secondhand: PriceRange | null },
  thresholds: DiscountPolicyThresholds = DEFAULT_DISCOUNT_POLICY,
): Promise<DiscountNotification | null> {
  const { priceAmount, productId } = listing
  if (priceAmount === null || isJunkPrice(priceAmount)) return null
  if (priceAmount < thresholds.minPricePesos) return null

  let referencePrice: number | null
  if (isNewCondition(listing.condition)) {
    referencePrice = pricing.retail ? pricing.retail.low : null
  } else if (pricing.secondhand) {
    referencePrice = pricing.secondhand.low
  } else {
    referencePrice = await getDiscountPeerMedian(db, productId)
  }

  if (referencePrice === null || referencePrice <= 0) return null
  if (isMagnitudeOutlier(priceAmount, referencePrice)) return null

  const discountPercent = Math.round(((referencePrice - priceAmount) / referencePrice) * 100)
  const profitPesos = referencePrice - priceAmount
  if (discountPercent < thresholds.highDiscountThresholdPercent || profitPesos < thresholds.minProfitPesos) return null

  return { listingId: listing.id, productId, discountPercent, referencePrice }
}

// One multi-row statement, so a batch's notifications land all or nothing.
// ON CONFLICT (listing_id) DO NOTHING enforces "at most one notification per
// listing ever", so re-inserting a decided notification is a no-op.
export async function insertDiscountNotifications(db: DbClient, notifications: DiscountNotification[]): Promise<void> {
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

export interface DiscountVerificationCandidate {
  id: number
  listing_id: string
  title: string | null
  description: string | null
  condition: string | null
  price_amount: number
  base_model: string
  is_specific_product: boolean | null
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
