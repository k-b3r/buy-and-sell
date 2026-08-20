import { Pool } from 'pg'
import { normalizeBaseModel } from './products'

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

export async function upsertListing(db: DbClient, listing: Record<string, unknown>): Promise<void> {
  const id = String(listing.id)
  const title = extractField(listing, 'marketplace_listing_title', 'custom_title') as string | null

  const priceObj = listing.listing_price as { amount?: string; currency?: string } | undefined
  const priceAmount = priceObj?.amount !== undefined ? Number(priceObj.amount) : null
  const priceCurrency = priceObj?.currency ?? null

  const description = (listing.redacted_description as { text?: string } | undefined)?.text ?? null
  const condition = (listing.condition as string | undefined) ?? null
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
      storedPhotoUrls ? JSON.stringify(storedPhotoUrls) : null,
      listedAt,
      JSON.stringify(listing),
    ],
  )
}

export async function findOrCreateProduct(
  db: DbClient,
  baseModel: string,
  variantTier: string | null,
): Promise<number> {
  const normalized = normalizeBaseModel(baseModel)

  const existing = (await db.query(
    `SELECT id FROM products WHERE base_model_normalized = $1 AND variant_tier IS NOT DISTINCT FROM $2`,
    [normalized, variantTier],
  )) as { rows: { id: number }[] }
  if (existing.rows.length > 0) return existing.rows[0].id

  const inserted = (await db.query(
    `INSERT INTO products (base_model, base_model_normalized, variant_tier) VALUES ($1, $2, $3) RETURNING id`,
    [baseModel, normalized, variantTier],
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
