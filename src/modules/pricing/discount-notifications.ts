import type { DbClient } from '../../platform/storage'
import type { PriceRange } from './price-lookup'
import { PLACEHOLDER_PRICE_SQL } from './listing-price-review'

// JS-side twin of PLACEHOLDER_PRICE_SQL above, for callers (checkListingDiscount)
// that already have the price as a JS number and don't need a SQL round trip.
const ASCENDING_RUN_RE = /012|123|234|345|456|567|678|789/
function isPlaceholderPrice(price: number): boolean {
  const digits = String(Math.trunc(Math.abs(price)))
  if (digits.length < 3) return false
  if (/^(\d+)\1+$/.test(digits)) return true
  return ASCENDING_RUN_RE.test(digits)
}

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

// Same raw-median -> clean-median formula as the dashboard's
// DISCOUNT_SUMMARY_LATERAL (dashboard/src/lib/queries.ts), scoped to one
// product - the fallback reference for checkListingDiscount below when real
// secondhand market data isn't available yet. Returns null (not 0) when
// there aren't at least 2 comparable sibling listings, same "nothing to
// compare against" case the dashboard's own version handles.
async function getPeerMedianPrice(db: DbClient, productId: number): Promise<number | null> {
  const result = (await db.query(
    `WITH product_prices AS (
       SELECT pl.price_amount
       FROM listings pl
       JOIN products p ON p.id = pl.product_id
       WHERE pl.product_id = $1 AND pl.price_amount IS NOT NULL AND pl.price_amount > 0
         AND NOT p.price_lookup_excluded
         AND NOT ${PLACEHOLDER_PRICE_SQL('pl.price_amount')}
     ),
     raw AS (
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_amount) AS median_price, count(*) AS n
       FROM product_prices
     )
     SELECT
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pp.price_amount)
        FROM product_prices pp, raw
        WHERE raw.n >= 2 AND raw.median_price > 0
          AND pp.price_amount BETWEEN raw.median_price / 10 AND raw.median_price * 10) AS clean_median_price
     FROM raw`,
    [productId],
  )) as { rows: { clean_median_price: string | null }[] }
  const value = result.rows[0]?.clean_median_price
  return value ? Number(value) : null
}

// "used" wins outright over "new" - "Used - like new" contains "new" but is
// never actually new-in-box. Same fix as discount-verification.ts's
// isNewCondition, duplicated here rather than imported (that module isn't
// committed yet as of 2026-08-31, and this is a small enough pure function
// that duplication is cheaper than the coupling).
function isNewCondition(condition: string | null): boolean {
  if (condition === null) return false
  const lower = condition.toLowerCase()
  if (lower.includes('used')) return false
  return lower.includes('new')
}

// Real-market-price-first discount check for a single listing, called
// inline right after its product has (or already had) retail/secondhand
// pricing ensured in extract-products.ts - the "trigger is retail pricing
// becoming available" design (2026-08-31), replacing the old
// batch-of-siblings-only check that could never fire on a product's first
// listing.
//
// Priority: secondhand (real market data) for any non-"New" listing - only
// falls back to peer-comparison (median of this product's own listings)
// when secondhand isn't available yet. "New" listings always compare
// against retail; a "New" listing is never passed here without a retail
// price already in hand (see ensureProductPriced's exclude-on-retail-miss
// behavior - a product with no retail was already excluded before this
// function would ever be called). ON CONFLICT (listing_id) DO NOTHING
// enforces "at most one notification per listing ever," same as before.
export async function checkListingDiscount(
  db: DbClient,
  listingId: string,
  productId: number,
  condition: string | null,
  priceAmount: number | null,
  retailPrice: PriceRange | null,
  secondhandPrice: PriceRange | null,
  thresholds: DiscountPolicyThresholds = DEFAULT_DISCOUNT_POLICY,
): Promise<void> {
  if (priceAmount === null || priceAmount <= 0) return
  if (priceAmount < thresholds.minPricePesos) return
  if (isPlaceholderPrice(priceAmount)) return

  let referencePrice: number | null
  if (isNewCondition(condition)) {
    referencePrice = retailPrice ? retailPrice.low : null
  } else if (secondhandPrice) {
    referencePrice = secondhandPrice.low
  } else {
    referencePrice = await getPeerMedianPrice(db, productId)
  }

  if (referencePrice === null || referencePrice <= 0) return
  if (priceAmount < referencePrice / 10 || priceAmount > referencePrice * 10) return // same magnitude-outlier guard as elsewhere

  const discountPercent = Math.round(((referencePrice - priceAmount) / referencePrice) * 100)
  const profitPesos = referencePrice - priceAmount
  if (discountPercent < thresholds.highDiscountThresholdPercent || profitPesos < thresholds.minProfitPesos) return

  await db.query(
    `INSERT INTO discount_notifications (listing_id, product_id, discount_percent, reference_price)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (listing_id) DO NOTHING`,
    [listingId, productId, discountPercent, referencePrice],
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
