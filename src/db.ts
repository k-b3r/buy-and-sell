import { Pool } from 'pg'
import { normalizeBaseModel, normalizeVariantTier } from './products'
import type { PriceRange } from './pricing'
import type { EnrichmentCandidate } from './enrichment'
import type { PriceReviewCandidate } from './price-review'
import type { CategoryBackfillCandidate } from './category-backfill'

export interface DbClient {
  query(sql: string, params: unknown[]): Promise<unknown>
}

export function createDbPool(connectionString: string): Pool {
  return new Pool({ connectionString })
}

function extractField(listing: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (listing[key] !== undefined && listing[key] !== null) return listing[key]
  }
  return null
}

interface ParsedListingFields {
  id: string
  title: string | null
  priceAmount: number | null
  priceCurrency: string | null
  description: string | null
  condition: string | null
  categoryId: string | null
  locationLat: number | null
  locationLng: number | null
  locationCity: string | null
  primaryPhotoUrl: string | null
  storedPhotoUrls: string[] | null
  listedAt: Date | null
}

// Shared by upsertListing (full insert/refresh, including photos) and
// refreshListingFields (text/price-only refresh, see below) so the two
// can't drift on how a raw Facebook listing object gets parsed.
function parseListingFields(listing: Record<string, unknown>): ParsedListingFields {
  const id = String(listing.id)
  const title = extractField(listing, 'marketplace_listing_title', 'custom_title') as string | null

  const priceObj = listing.listing_price as { amount?: string; currency?: string } | undefined
  const priceAmount = priceObj?.amount !== undefined ? Number(priceObj.amount) : null
  const priceCurrency = priceObj?.currency ?? null

  const description = (listing.redacted_description as { text?: string } | undefined)?.text ?? null
  // Facebook nests condition inside attribute_data (an array of {label, value,
  // attribute_name} entries covering Condition, Brand, etc.), not a top-level
  // "condition" field — confirmed live, 97% of real listings have it here.
  const attributeData = listing.attribute_data as { label?: string; attribute_name?: string }[] | undefined
  const condition = attributeData?.find((a) => a.attribute_name === 'Condition')?.label ?? null
  const categoryId = (listing.marketplace_listing_category_id as string | undefined) ?? null

  const location = listing.location as
    | { latitude?: number; longitude?: number; reverse_geocode?: { city?: string } }
    | undefined
  const locationLat = location?.latitude ?? null
  const locationLng = location?.longitude ?? null
  const locationCity = location?.reverse_geocode?.city ?? null

  const primaryPhotoUrl =
    (listing.primary_listing_photo as { image?: { uri?: string } } | undefined)?.image?.uri ?? null
  const storedPhotoUrls = (listing.stored_photo_urls as string[] | undefined) ?? null

  const creationTime = listing.creation_time as number | undefined
  const listedAt = creationTime ? new Date(creationTime * 1000) : null

  return {
    id,
    title,
    priceAmount,
    priceCurrency,
    description,
    condition,
    categoryId,
    locationLat,
    locationLng,
    locationCity,
    primaryPhotoUrl,
    storedPhotoUrls,
    listedAt,
  }
}

export async function upsertListing(db: DbClient, listing: Record<string, unknown>): Promise<void> {
  const f = parseListingFields(listing)

  await db.query(
    `INSERT INTO listings (
       id, title, price_amount, price_currency, description, condition, category_id,
       location_lat, location_lng, location_city, primary_photo_url, stored_photo_urls, listed_at, raw_json
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       price_amount = EXCLUDED.price_amount,
       price_currency = EXCLUDED.price_currency,
       description = EXCLUDED.description,
       condition = EXCLUDED.condition,
       category_id = EXCLUDED.category_id,
       location_lat = EXCLUDED.location_lat,
       location_lng = EXCLUDED.location_lng,
       location_city = EXCLUDED.location_city,
       primary_photo_url = EXCLUDED.primary_photo_url,
       stored_photo_urls = EXCLUDED.stored_photo_urls,
       listed_at = EXCLUDED.listed_at,
       raw_json = EXCLUDED.raw_json,
       last_seen_at = now(),
       updated_at = now()`,
    [
      f.id,
      f.title,
      f.priceAmount,
      f.priceCurrency,
      f.description,
      f.condition,
      f.categoryId,
      f.locationLat,
      f.locationLng,
      f.locationCity,
      f.primaryPhotoUrl,
      f.storedPhotoUrls ? JSON.stringify(f.storedPhotoUrls) : null,
      f.listedAt,
      JSON.stringify(listing),
    ],
  )
}

// check-listings.ts calls this when a re-checked listing is confirmed still
// live (not sold/removed) - a re-scraped detail page reflects whatever the
// seller has since edited (price cut, updated description, corrected
// condition), so without this the stored row would only ever show its
// first-seen snapshot forever. Deliberately excludes photo fields
// (primary_photo_url/stored_photo_urls) and category_id/location - a plain
// detail-page scrape has no knowledge of the R2-uploaded copy backfill.ts
// already produced, and overwriting with the raw FB CDN link (or null)
// would silently undo that work.
export async function refreshListingFields(db: DbClient, listing: Record<string, unknown>): Promise<void> {
  const f = parseListingFields(listing)

  await db.query(
    `UPDATE listings SET
       title = $2,
       price_amount = $3,
       price_currency = $4,
       description = $5,
       condition = $6,
       raw_json = $7,
       last_seen_at = now(),
       updated_at = now()
     WHERE id = $1`,
    [f.id, f.title, f.priceAmount, f.priceCurrency, f.description, f.condition, JSON.stringify(listing)],
  )
}

// category is only ever set at creation, same as base_model/variant_tier —
// dashboard browsing/filtering only, not re-classified on subsequent
// extraction passes that happen to match an existing product.
export async function findOrCreateProduct(
  db: DbClient,
  baseModel: string,
  variantTier: string | null,
  category: string | null = null,
): Promise<number> {
  const normalized = normalizeBaseModel(baseModel)
  const normalizedVariant = variantTier === null ? null : normalizeVariantTier(variantTier)

  const existing = (await db.query(
    `SELECT id FROM products WHERE base_model_normalized = $1 AND variant_tier_normalized IS NOT DISTINCT FROM $2`,
    [normalized, normalizedVariant],
  )) as { rows: { id: number }[] }
  if (existing.rows.length > 0) return existing.rows[0].id

  const inserted = (await db.query(
    `INSERT INTO products (base_model, base_model_normalized, variant_tier, variant_tier_normalized, category_id)
     VALUES ($1, $2, $3, $4, (SELECT id FROM categories WHERE name = $5)) RETURNING id`,
    [baseModel, normalized, variantTier, normalizedVariant, category],
  )) as { rows: { id: number }[] }
  return inserted.rows[0].id
}

// Assigns product_id to many listings in a single round trip instead of one UPDATE
// per listing — the per-listing version was the dominant cost of a Pass 1/2 run
// (each remote Postgres round trip to Neon dwarfs the batched Gemini calls).
export async function updateListingProductIds(
  db: DbClient,
  assignments: { id: string; productId: number }[],
): Promise<void> {
  if (assignments.length === 0) return

  const valuesSql = assignments.map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::int)`).join(', ')
  const params = assignments.flatMap((a) => [a.id, a.productId])

  await db.query(
    `UPDATE listings SET product_id = data.product_id
     FROM (VALUES ${valuesSql}) AS data(id, product_id)
     WHERE listings.id = data.id`,
    params,
  )
}

// Always an INSERT, never an upsert — each price check is a new point in the
// product's price history, not a replacement of the last one. This is what
// makes a price trend possible: query product_price_history ordered by
// checked_at, don't just read a single "current price" column.
export type PriceCheckSource = 'gemini_grounding' | 'listing_prices' | 'exa_new_retail'

// confidence is Exa-specific (its grounding data reports "high"/"low" per
// field, see extractNewPriceConfidence) — null for gemini_grounding/
// listing_prices sources, which have no equivalent signal. releaseYear/
// isDiscontinued are likewise Exa-only (extractNewPriceMetadata) — free
// extra fields from the same already-paid-for search.
export async function insertPriceCheck(
  db: DbClient,
  productId: number,
  price: PriceRange,
  rawResponse: string,
  source: PriceCheckSource,
  condition: string | null = null,
  confidence: string | null = null,
  releaseYear: number | null = null,
  isDiscontinued: boolean | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO product_price_history (product_id, price_low, price_high, price_currency, raw_response, source, condition, confidence, release_year, is_discontinued)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [productId, price.low, price.high, price.currency, rawResponse, source, condition, confidence, releaseYear, isDiscontinued],
  )
}

export interface CheckListingsCandidate {
  id: string
  flagged_removed_at: string | null
}

// Never-checked listings (NULLS FIRST) all come before any re-check cycle —
// the first full pass works through the backlog before anything repeats.
// Within that, oldest by the seller's actual FB posting date (listed_at)
// goes first: the longer something's been posted, the likelier it's already
// sold/removed, so checking those first finds genuinely-stale listings fastest.
export async function getCheckListingsCandidates(db: DbClient, limit: number): Promise<CheckListingsCandidate[]> {
  const result = (await db.query(
    `SELECT id, flagged_removed_at FROM listings
     WHERE sold_at IS NULL
     ORDER BY last_checked_at ASC NULLS FIRST, listed_at ASC NULLS LAST
     LIMIT $1`,
    [limit],
  )) as { rows: CheckListingsCandidate[] }
  return result.rows
}

// Real content found — clears any prior removal flag too, treating a listing
// that recovers after being flagged as a false positive, not something to
// silently leave flagged. Also clears sold_at, for the same reason (a listing
// that's actually still live and unsold shouldn't stay marked sold).
export async function markListingAlive(db: DbClient, id: string): Promise<void> {
  await db.query(
    `UPDATE listings SET last_checked_at = now(), flagged_removed_at = NULL, sold_at = NULL WHERE id = $1`,
    [id],
  )
}

// Sold is a terminal, definite signal from Facebook itself (raw_json.is_sold) —
// no soft-wall-style two-phase confirmation needed, unlike flagListingRemoved.
// getCheckListingsCandidates excludes sold_at IS NOT NULL rows, so a sold
// listing is never re-checked again.
export async function markListingSold(db: DbClient, id: string): Promise<void> {
  await db.query(`UPDATE listings SET sold_at = now(), last_checked_at = now() WHERE id = $1`, [id])
}

// First soft-wall hit — not deleted yet. See db/schema.sql for why one hit
// alone isn't trusted (indistinguishable from a transient session wall).
export async function flagListingRemoved(db: DbClient, id: string): Promise<void> {
  await db.query(`UPDATE listings SET flagged_removed_at = now(), last_checked_at = now() WHERE id = $1`, [id])
}

// Only called when a listing was already flagged from a prior, separate run
// and is still soft-walled now — confirmed removed. Products are never
// cascade-deleted here, even if this was their last remaining listing.
export async function deleteListing(db: DbClient, id: string): Promise<void> {
  await db.query(`DELETE FROM listings WHERE id = $1`, [id])
}

export interface NewPriceCandidate {
  id: number
  base_model: string
  variant_tier: string | null
  description: string | null
  sibling_variants: string[]
}

// New-retail price is a per-model fact, not tied to condition or how many
// listings we've collected of it — unlike getPriceLookupCandidates (which
// only bothers with products that have >=2 listings), every product is a
// candidate. Skips any product with a price row from ANY source (not just
// exa_new_retail) — a product already priced by gemini_grounding or
// listing_prices doesn't need an Exa call too (each Exa search costs real
// money, unlike Groq/Gemini's free tiers). Resumable via NOT EXISTS, first-
// pass fill, not a re-check-every-run trend. description/sibling_variants
// (same LEFT JOIN / sibling-lookup shape as getEnrichmentCandidates) give
// Exa's search disambiguating context — description may be null if this
// product hasn't been through enrich-products.ts yet.
export async function getNewPriceCandidates(db: DbClient): Promise<NewPriceCandidate[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, e.description,
       COALESCE(
         (SELECT array_agg(DISTINCT COALESCE(p2.variant_tier, '(base, no variant)'))
          FROM products p2
          WHERE p2.base_model_normalized = p.base_model_normalized AND p2.id != p.id),
         ARRAY[]::text[]
       ) as sibling_variants
     FROM products p
     LEFT JOIN product_enrichment e ON e.product_id = p.id
     WHERE NOT p.price_lookup_excluded
       AND NOT EXISTS (
         SELECT 1 FROM product_price_history h WHERE h.product_id = p.id
       )
     ORDER BY p.id`,
    [],
  )) as { rows: NewPriceCandidate[] }
  return result.rows
}

// Manually curated categories (real estate, bare placeholders, parts with no
// single fixed price, services) — see db/schema.sql. Idempotent: matches on
// base_model text, safe to re-run as more junk categories turn up over time.
export async function flagPriceLookupExcluded(db: DbClient, baseModels: string[], reason: string): Promise<void> {
  await db.query(`UPDATE products SET price_lookup_excluded = true, price_lookup_excluded_reason = $1 WHERE base_model = ANY($2)`, [
    reason,
    baseModels,
  ])
}

// Per-product, not per-category — called when Exa itself searched and came up
// empty for this specific product (see new-price-lookup.ts), not for a
// transient request failure. One real "no result" is a strong enough signal
// not to keep paying for the same search again on every future run.
export async function flagProductPriceLookupExcluded(db: DbClient, productId: number, reason: string): Promise<void> {
  await db.query(`UPDATE products SET price_lookup_excluded = true, price_lookup_excluded_reason = $1 WHERE id = $2`, [reason, productId])
}

// Merges loserId into survivorId — same real product, split into two rows by
// inconsistent extraction text (e.g. "PS5" vs "PlayStation 5"). Reassigns real
// scraped/paid data (listings, product_price_history) unconditionally. For
// product_enrichment (product_id is its PRIMARY KEY, so both rows can't keep
// one each): migrates the loser's row over only if the survivor doesn't
// already have one, otherwise just drops the loser's — it's free/regenerable
// via Groq, not worth reconciling two descriptions. Caller is responsible for
// deciding survivor/loser and must not call this if it would collide with a
// still-existing third row (see merge-duplicate-products.ts).
export async function mergeDuplicateProduct(db: DbClient, survivorId: number, loserId: number): Promise<void> {
  await db.query(`UPDATE listings SET product_id = $1 WHERE product_id = $2`, [survivorId, loserId])
  await db.query(`UPDATE product_price_history SET product_id = $1 WHERE product_id = $2`, [survivorId, loserId])
  await db.query(
    `UPDATE product_enrichment SET product_id = $1
     WHERE product_id = $2 AND NOT EXISTS (SELECT 1 FROM product_enrichment WHERE product_id = $1)`,
    [survivorId, loserId],
  )
  await db.query(`DELETE FROM product_enrichment WHERE product_id = $1`, [loserId])
  await db.query(`DELETE FROM products WHERE id = $1`, [loserId])
}

export async function getEnrichmentCandidates(db: DbClient): Promise<EnrichmentCandidate[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, c.name AS category,
       COALESCE(
         (SELECT array_agg(DISTINCT COALESCE(p2.variant_tier, '(base, no variant)'))
          FROM products p2
          WHERE p2.base_model_normalized = p.base_model_normalized AND p2.id != p.id),
         ARRAY[]::text[]
       ) as sibling_variants
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE NOT EXISTS (SELECT 1 FROM product_enrichment e WHERE e.product_id = p.id)
     ORDER BY p.id`,
    [],
  )) as { rows: EnrichmentCandidate[] }
  return result.rows
}

export interface EnrichmentData {
  description: string
  valueDrivers: string
  hasTrainedPriceKnowledge: boolean
  trainedPriceLow: number | null
  trainedPriceHigh: number | null
}

export async function upsertProductEnrichment(
  db: DbClient,
  productId: number,
  data: EnrichmentData,
  model: string,
): Promise<void> {
  const trainedPriceCurrency = data.trainedPriceLow !== null ? 'PHP' : null
  await db.query(
    `INSERT INTO product_enrichment
       (product_id, description, value_drivers, has_trained_price_knowledge, trained_price_low, trained_price_high, trained_price_currency, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (product_id) DO UPDATE SET
       description = EXCLUDED.description,
       value_drivers = EXCLUDED.value_drivers,
       has_trained_price_knowledge = EXCLUDED.has_trained_price_knowledge,
       trained_price_low = EXCLUDED.trained_price_low,
       trained_price_high = EXCLUDED.trained_price_high,
       trained_price_currency = EXCLUDED.trained_price_currency,
       model = EXCLUDED.model,
       checked_at = now()`,
    [
      productId,
      data.description,
      data.valueDrivers,
      data.hasTrainedPriceKnowledge,
      data.trainedPriceLow,
      data.trainedPriceHigh,
      trainedPriceCurrency,
      model,
    ],
  )
}

// Cheap SQL-only pre-filter, no LLM: flags listings whose price is more than
// 10x off their product's own median in either direction. Products with only
// one listing can never flag themselves (their price equals their own median).
// NOT EXISTS on listing_price_review is the resumability mechanism, same
// pattern as getEnrichmentCandidates.
export async function getPriceReviewCandidates(db: DbClient): Promise<PriceReviewCandidate[]> {
  const result = (await db.query(
    `WITH product_medians AS (
       SELECT product_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_amount) AS median_price
       FROM listings
       WHERE product_id IS NOT NULL AND price_amount IS NOT NULL AND price_amount > 0
       GROUP BY product_id
     )
     SELECT l.id, l.title, l.description, l.price_amount
     FROM listings l
     JOIN product_medians m ON m.product_id = l.product_id
     WHERE l.price_amount IS NOT NULL
       AND (l.price_amount < m.median_price / 10 OR l.price_amount > m.median_price * 10)
       AND NOT EXISTS (SELECT 1 FROM listing_price_review r WHERE r.listing_id = l.id)`,
    [],
  )) as { rows: Record<string, unknown>[] }
  return result.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    description: r.description as string | null,
    price_amount: Number(r.price_amount),
  }))
}

export interface PriceReviewData {
  isNegotiable: boolean
  priceLow: number | null
  priceHigh: number | null
  reasoning: string
}

// listings.price_amount is never written here - this table is purely additive,
// same as product_enrichment is for products (see db/schema.sql).
export async function upsertListingPriceReview(
  db: DbClient,
  listingId: string,
  data: PriceReviewData,
  model: string,
): Promise<void> {
  await db.query(
    `INSERT INTO listing_price_review (listing_id, is_negotiable, price_low, price_high, reasoning, model)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (listing_id) DO UPDATE SET
       is_negotiable = EXCLUDED.is_negotiable,
       price_low = EXCLUDED.price_low,
       price_high = EXCLUDED.price_high,
       reasoning = EXCLUDED.reasoning,
       model = EXCLUDED.model,
       checked_at = now()`,
    [listingId, data.isNegotiable, data.priceLow, data.priceHigh, data.reasoning, model],
  )
}

// Dedup source for collection runs — replaces the old JSONL-file-based
// loadPersistedIds. Postgres is the single source of truth now; no local
// file can drift out of sync with it (see CONTEXT.md on removing JSONL).
export async function getCollectedListingIds(db: DbClient): Promise<Set<string>> {
  const result = (await db.query('SELECT id FROM listings', [])) as { rows: { id: string }[] }
  return new Set(result.rows.map((r) => r.id))
}

export interface ExtractionCandidate {
  id: string
  title: string
  description: string | null
}

export async function getExtractionCandidates(db: DbClient): Promise<ExtractionCandidate[]> {
  const result = (await db.query(
    `SELECT id, title, description FROM listings WHERE product_id IS NULL`,
    [],
  )) as { rows: ExtractionCandidate[] }
  return result.rows
}

export interface BackfillCandidate {
  id: string
  raw_json: Record<string, unknown>
}

export async function getBackfillCandidates(db: DbClient): Promise<BackfillCandidate[]> {
  const result = (await db.query(
    `SELECT id, raw_json FROM listings WHERE stored_photo_urls IS NULL`,
    [],
  )) as { rows: BackfillCandidate[] }
  return result.rows
}

// Reversible: a listing later confirmed still live (via a validation pass)
// can just be re-run through backfill, which overwrites this with real URLs.
export async function markListingPhotosUnavailable(db: DbClient, id: string): Promise<void> {
  await db.query(`UPDATE listings SET stored_photo_urls = '[]'::jsonb WHERE id = $1`, [id])
}

// category_id IS NULL is both the filter and the resumability marker — no
// separate results table needed (same pattern as getEnrichmentCandidates).
// Only pre-existing products lack a category; extract-products.ts assigns it
// at creation time for everything new, so this backlog only shrinks.
export async function getCategoryBackfillCandidates(db: DbClient): Promise<CategoryBackfillCandidate[]> {
  const result = (await db.query(
    `SELECT id, base_model, variant_tier FROM products WHERE category_id IS NULL ORDER BY id`,
    [],
  )) as { rows: CategoryBackfillCandidate[] }
  return result.rows
}

// Batched single round trip, same reasoning as updateListingProductIds — the
// Neon round-trip cost dwarfs the LLM cost here. Assignments carry the
// category NAME (from the LLM response / caller), resolved to category_id
// via the join below — categories is a small fixed seeded set, never
// written to here.
export async function updateProductCategories(
  db: DbClient,
  assignments: { id: number; category: string }[],
): Promise<void> {
  if (assignments.length === 0) return

  const valuesSql = assignments.map((_, i) => `($${i * 2 + 1}::int, $${i * 2 + 2}::text)`).join(', ')
  const params = assignments.flatMap((a) => [a.id, a.category])

  await db.query(
    `UPDATE products SET category_id = c.id
     FROM (VALUES ${valuesSql}) AS data(id, category)
     JOIN categories c ON c.name = data.category
     WHERE products.id = data.id`,
    params,
  )
}
