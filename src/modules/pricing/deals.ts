import type { DbClient, QueryClient } from '../../platform/storage'
import { resolvePhotoUrls, toNullableNumber } from '../../platform/rows'
import { medianCtes, notJunkPriceSql, notMagnitudeOutlierSql, peerListingSql } from './clean-median'
import { SECONDHAND_PRICE_LATERAL } from './price-rules'
import { repostKeySql } from './repost'
import { TIER_RANK_SQL } from '../../platform/pricing-sql'

type DealsConfidenceTier = 'sold_comps' | 'peer_listings' | 'llm_estimate'

const CONFIDENCE_TIER_RANK: Record<DealsConfidenceTier, number> = {
  sold_comps: 3,
  peer_listings: 2,
  llm_estimate: 1,
}

// Same ranking baked into SQL as TIER_RANK_SQL below - kept in one place so
// a minConfidenceTier filter and the tier's own displayed rank can't drift.

export interface DealListing {
  listing_id: string
  title: string
  ask_price: number
  photo_url: string | null
  product_id: number | null
  base_model: string | null
  variant_tier: string | null
  category: string | null
  sub_category: string | null
  reference_price: number | null
  tier: DealsConfidenceTier | null
  // Count of comparable listings behind the winning tier - sold listings for
  // sold_comps, active peer listings for peer_listings, null for
  // llm_estimate (nothing to count) or no tier at all.
  comp_count: number | null
  profit_pesos: number | null
  discount_percent: number | null
  days_listed: number | null
  is_saved: boolean
  is_low_confidence: boolean
}

export interface DealsDiscountPolicyFloors {
  minProfitPesos: number
  minPricePesos: number
}

export interface DealsFilters {
  search?: string
  categories?: string[]
  minProfitPesos?: number
  minConfidenceTier?: DealsConfidenceTier
  maxDaysListed?: number
  // Hours since our collector first saw the listing (first_seen_at), not the
  // seller's FB posting date that maxDaysListed uses.
  addedWithinHours?: number
  soldOnly?: boolean
  lowConfidenceOnly?: boolean
  offset?: number
  limit?: number
}

const DEALS_DEFAULT_LIMIT = 30
// Confirmed live 2026-09-03: phones dominate the ranked list because they
// both (a) dedupe cleanly into one product across many sellers, reaching the
// sold_comps/peer_listings tiers far more often than one-off items (~75% of
// all products are singleton-listing), and (b) produce
// bigger absolute profit_pesos at their price point even at the same
// discount %, and profit_pesos - not a normalized rate - is the tie-breaker
// within a tier. No per-category cap meant a strong category could fill
// every slot on the page. Applied to the main ranked list only, not the
// low-confidence bucket (see lowConfidenceOnly below).
const DEALS_CATEGORY_CAP = 10

// /deals page's ranked-by-profit view of active listings. One row per
// listing (not per product like getProductSummaries) - a product with 5
// active listings is 5 separate buy-and-sell opportunities, each with its
// own ask price.
//
// Reference-price fallback chain, highest confidence first (see
// getSoldComparablePrice/getPeerMedianPrice in queries.ts for the same clean-median
// approach applied per-tier): sold comps (n>=3 actual sales) -> peer
// listings (scope in peerListingSql, n>=3) -> LLM estimate (used_price_low/high, falling back to
// enrichment's trained_price_low/high the same way resolveSecondhandPrice
// does in price-rules.ts, collapsed to a single point estimate via
// midpoint since the deals page ranks by one number, not a range).
// Everything computed in one SQL pass (not fetched raw then filtered/sorted
// in JS) so profit-based filtering, tier-rank filtering, and ORDER BY/LIMIT
// all operate on the real ranking key instead of an unfiltered page of raw
// listings that then shrinks unpredictably after JS-side filtering.
//
// "Low confidence" bucket: an llm_estimate-
// tier row whose product has at most 1 active priced peer listing (i.e. this
// listing IS that product's only current listing - a singleton, per the
// ~75%-singleton finding above) is too thin a guess to rank
// alongside real comps. lowConfidenceOnly toggles between the main ranked
// list (excludes these + tier-less rows) and this bucket (only these).
export async function getDeals(
  db: QueryClient,
  discountPolicy: DealsDiscountPolicyFloors,
  filters: DealsFilters = {},
): Promise<DealListing[]> {
  const params: unknown[] = []
  const push = (value: unknown): string => {
    params.push(value)
    return `$${params.length}`
  }

  const soldClause = filters.soldOnly ? 'l.sold_at IS NOT NULL' : 'l.sold_at IS NULL'

  // Policy floor is a hard minimum, not just a default - a filter asking for
  // less than the floor doesn't get to punch through it (min_profit_pesos/min_price_pesos
  // are operator-tunable
  // policy, not something this page's UI should be able to undercut).
  const minProfitPesos = Math.max(discountPolicy.minProfitPesos, filters.minProfitPesos ?? 0)
  const minProfitPlaceholder = push(minProfitPesos)
  const minPricePlaceholder = push(discountPolicy.minPricePesos)
  const minTierRank = filters.minConfidenceTier ? CONFIDENCE_TIER_RANK[filters.minConfidenceTier] : 0
  const minTierPlaceholder = push(minTierRank)
  const lowConfidenceOnlyPlaceholder = push(!!filters.lowConfidenceOnly)

  let categoryClause = ''
  if (filters.categories && filters.categories.length > 0) {
    categoryClause = `AND category = ANY(${push(filters.categories)})`
  }
  let daysListedClause = ''
  if (filters.maxDaysListed !== undefined) {
    daysListedClause = `AND days_listed IS NOT NULL AND days_listed <= ${push(filters.maxDaysListed)}`
  }
  let addedWithinClause = ''
  if (filters.addedWithinHours !== undefined) {
    addedWithinClause = `AND first_seen_at >= now() - make_interval(hours => ${push(filters.addedWithinHours)})`
  }
  // Against title and base_model - a listing's title is what's actually
  // shown on the row (and what a search term is most likely echoing back),
  // base_model as a fallback for titles that don't spell the product name
  // out plainly (e.g. a title that's just "RUSH SALE!!! 🔥🔥🔥").
  let searchClause = ''
  const trimmedSearch = filters.search?.trim()
  if (trimmedSearch) {
    const searchPlaceholder = push(`%${trimmedSearch}%`)
    searchClause = `AND (title ILIKE ${searchPlaceholder} OR base_model ILIKE ${searchPlaceholder})`
  }

  const limit = filters.limit ?? DEALS_DEFAULT_LIMIT
  const offset = filters.offset ?? 0
  const limitPlaceholder = push(limit)
  const offsetPlaceholder = push(offset)
  const categoryCapPlaceholder = push(DEALS_CATEGORY_CAP)

  const result = await db.query(
    `WITH ${medianCtes({
      name: 'sold_comp',
      pool: `SELECT pl.product_id, pl.price_amount FROM listings pl
             JOIN products prod ON prod.id = pl.product_id
             WHERE pl.sold_at IS NOT NULL AND NOT prod.price_lookup_excluded`,
    })},
     ${medianCtes({
       name: 'peer_median',
       pool: `SELECT pl.product_id, pl.price_amount FROM listings pl
              JOIN products prod ON prod.id = pl.product_id
              WHERE ${peerListingSql('pl')} AND NOT prod.price_lookup_excluded`,
     })},
     -- Deduped to one row per product with at least one active listing (not
     -- one LATERAL invocation per listing) - same "evaluate once per
     -- product" fix getProductSummaries' comment documents learning the
     -- hard way (2026-08-24 EXPLAIN ANALYZE).
     --
     -- price_lookup_excluded gated here too, not just in sold_comp/peer_median
     -- above - without it, an excluded product's llm_estimate still slipped
     -- through (product_enrichment/product_price_history aren't gated on the
     -- flag either). Confirmed live 2026-09-02: two different "House & Lot"
     -- listings (price_lookup_excluded=true, real estate never got real
     -- price-lookup treatment) shared the same nonsense trained-price
     -- estimate and showed as ₱200M+ "deals" in the low-confidence bucket.
     p AS (
       SELECT DISTINCT l.product_id AS id FROM listings l
       JOIN products prod ON prod.id = l.product_id
       WHERE l.product_id IS NOT NULL AND (${soldClause}) AND l.flagged_removed_at IS NULL
         AND NOT prod.price_lookup_excluded
     ),
     llm_estimate AS (
       SELECT p.id AS product_id, up.price_low AS used_price_low, up.price_high AS used_price_high,
              e.has_trained_price_knowledge, e.trained_price_low, e.trained_price_high
       FROM p
       ${SECONDHAND_PRICE_LATERAL}
       LEFT JOIN product_enrichment e ON e.product_id = p.id
     ),
     deal AS (
       SELECT
         l.id AS listing_id, l.title,
         -- Prefer the price review's read over the raw recorded number when
         -- one exists - listing_price_review.price_amount is never written
         -- to (db/schema.sql), so a data error (dropped digit, placeholder)
         -- survives here otherwise. price_high (not price_low) so a bundle
         -- range doesn't understate what you'd actually pay and inflate
         -- profit_pesos. Confirmed live 2026-09-02: an iPhone 16 recorded at
         -- ₱3,900 (real ask ₱39,000 per its description) ranked as an
         -- ₱29,850-profit "deal" - within the 10x-of-reference guard below
         -- on the raw number alone.
         COALESCE(pr.price_high, pr.price_low, l.price_amount) AS ask_price,
         l.listed_at, l.first_seen_at,
         l.primary_photo_url, l.stored_photo_urls, l.product_id,
         prod.base_model, prod.variant_tier, cat.name AS category, subcat.name AS sub_category,
         sv.listing_id IS NOT NULL AS is_saved,
         pm.sample_size AS peer_sample_size,
         COALESCE(
           sc.clean_median_price,
           pm.clean_median_price,
           CASE
             WHEN le.used_price_low IS NOT NULL THEN (le.used_price_low + le.used_price_high) / 2.0
             WHEN le.has_trained_price_knowledge THEN (le.trained_price_low + le.trained_price_high) / 2.0
             ELSE NULL
           END
         ) AS reference_price,
         CASE
           WHEN sc.clean_median_price IS NOT NULL THEN 'sold_comps'
           WHEN pm.clean_median_price IS NOT NULL THEN 'peer_listings'
           WHEN le.used_price_low IS NOT NULL OR le.has_trained_price_knowledge THEN 'llm_estimate'
           ELSE NULL
         END AS tier,
         -- Same branch as tier above (kept as its own CASE, not a lookup off
         -- tier, since tier isn't computed yet at this point in the SELECT).
         CASE
           WHEN sc.clean_median_price IS NOT NULL THEN sc.sample_size
           WHEN pm.clean_median_price IS NOT NULL THEN pm.sample_size
           ELSE NULL
         END AS comp_count,
         EXTRACT(EPOCH FROM (now() - l.listed_at)) / 86400 AS days_listed
       FROM listings l
       JOIN products prod ON prod.id = l.product_id
       LEFT JOIN categories cat ON cat.id = prod.category_id
       LEFT JOIN categories subcat ON subcat.id = prod.sub_category_id
       LEFT JOIN saved_listings sv ON sv.listing_id = l.id
       LEFT JOIN sold_comp sc ON sc.product_id = prod.id
       LEFT JOIN peer_median pm ON pm.product_id = prod.id
       LEFT JOIN llm_estimate le ON le.product_id = prod.id
       LEFT JOIN listing_price_review pr ON pr.listing_id = l.id
       WHERE ${soldClause} AND l.flagged_removed_at IS NULL
         AND l.price_amount IS NOT NULL AND ${notJunkPriceSql('l.price_amount')}
     ),
     -- Collapses same-seller reposts (identical title, same product,
     -- different listing ids - confirmed live 2026-09-02: two "IPHONE 14"
     -- listings posted 64s apart, same price) down to one row, same
     -- repost key the product page flags reposts with (repost.ts) - without
     -- this, /deals ranked the same real-world item twice. Keeps the
     -- earliest listing (accurate days_listed).
     deal_deduped AS (
       SELECT DISTINCT ON (product_id, ${repostKeySql('title', 'listing_id')}) *
       FROM deal
       ORDER BY product_id, ${repostKeySql('title', 'listing_id')}, listed_at ASC NULLS LAST, listing_id
     ),
     filtered AS (
       SELECT
         deal_deduped.*,
         (reference_price - ask_price) AS profit_pesos,
         CASE WHEN reference_price > 0 THEN round(((reference_price - ask_price) / reference_price) * 100) ELSE NULL END AS discount_percent,
         (tier IS NULL OR (tier = 'llm_estimate' AND COALESCE(peer_sample_size, 0) <= 1)) AS is_low_confidence
       FROM deal_deduped
       WHERE ask_price >= ${minPricePlaceholder}
         -- Same magnitude-outlier guard detectAndRecordDiscountNotifications
         -- applies before ever recording a discount (discount-
         -- notifications.ts) - a joke/decoy ask (e.g. ₱700 for an iPhone
         -- 16 Pro Max, confirmed live 2026-09-02) is 10x+ below its own
         -- reference price and would otherwise rank as the single best "deal"
         -- on the page. Skipped only when there's no reference_price at all
         -- (nothing to compare against - those rows are already routed to the
         -- low-confidence bucket by the tier IS NULL branch below); a
         -- non-positive reference drops the row.
         AND ${notMagnitudeOutlierSql('ask_price', 'reference_price')}
         AND (tier IS NULL OR (tier = 'llm_estimate' AND COALESCE(peer_sample_size, 0) <= 1)) = ${lowConfidenceOnlyPlaceholder}
         AND (${lowConfidenceOnlyPlaceholder} OR reference_price - ask_price >= ${minProfitPlaceholder})
         AND (${lowConfidenceOnlyPlaceholder} OR ${TIER_RANK_SQL} >= ${minTierPlaceholder})
         ${categoryClause}
         ${daysListedClause}
         ${addedWithinClause}
         ${searchClause}
     ),
     -- Ranks each category's own deals separately (same ordering as the
     -- final list) so DEALS_CATEGORY_CAP can cut a category off before it
     -- fills the whole page - see that constant's comment above. NULL
     -- categories (the ~2,822 pre-2026-08-23 products never backfilled) are
     -- grouped into their own bucket via COALESCE so they're capped the same
     -- way instead of being exempt.
     capped AS (
       SELECT filtered.*,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(category, '')
           ORDER BY ${TIER_RANK_SQL} DESC, profit_pesos DESC NULLS LAST, listing_id
         ) AS category_rank
       FROM filtered
     )
     SELECT *
     FROM capped
     -- Cap only applies to the main ranked list, not the low-confidence
     -- bucket (that one isn't tier/profit-ranked the same way).
     WHERE ${lowConfidenceOnlyPlaceholder} OR category_rank <= ${categoryCapPlaceholder}
     -- Tier first (sold comps > peer listings > llm estimate - stronger
     -- evidence always outranks placement, per direct instruction
     -- 2026-09-02), profit only breaks ties within the same tier - without
     -- this a huge-profit llm_estimate guess could rank above a modest but
     -- real sold-comps deal.
     ORDER BY ${TIER_RANK_SQL} DESC, profit_pesos DESC NULLS LAST, listing_id
     LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    params,
  )

  return (result.rows as Record<string, unknown>[]).map((r) => ({
    listing_id: r.listing_id as string,
    title: r.title as string,
    ask_price: Number(r.ask_price),
    photo_url: resolvePhotoUrls(r.stored_photo_urls, r.primary_photo_url)[0] ?? null,
    product_id: r.product_id as number | null,
    base_model: r.base_model as string | null,
    variant_tier: r.variant_tier as string | null,
    category: r.category as string | null,
    sub_category: r.sub_category as string | null,
    reference_price: toNullableNumber(r.reference_price),
    tier: r.tier as DealsConfidenceTier | null,
    comp_count: r.comp_count === null || r.comp_count === undefined ? null : Number(r.comp_count),
    profit_pesos: toNullableNumber(r.profit_pesos),
    discount_percent: toNullableNumber(r.discount_percent),
    days_listed: r.days_listed === null || r.days_listed === undefined ? null : Math.floor(Number(r.days_listed)),
    is_saved: r.is_saved as boolean,
    is_low_confidence: r.is_low_confidence as boolean,
  }))
}

// Ids of the listings /deals currently ranks (main list, same filters and
// category cap), for check-listings to verify availability first. Reuses
// getDeals so "is a deal" has one definition.
export async function getDealListingIds(
  db: DbClient,
  discountPolicy: DealsDiscountPolicyFloors,
  limit: number,
): Promise<string[]> {
  const rowsDb: QueryClient = { query: async (sql, params) => (await db.query(sql, params)) as { rows: unknown[] } }
  const deals = await getDeals(rowsDb, discountPolicy, { limit })
  return deals.map((d) => d.listing_id)
}
