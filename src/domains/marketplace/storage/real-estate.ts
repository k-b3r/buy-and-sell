import type { DbClient } from '../../../platform/storage'
import type { RealEstateCandidate, RealEstateFields } from '../real-estate'

// Computed in SQL both when selecting candidates and (via the value returned
// here) when storing, so the JS side never has to reproduce the hash.
const SOURCE_HASH_SQL = `md5(coalesce(l.title, '') || '|' || coalesce(l.description, '') || '|' || coalesce(l.price_amount::text, ''))`

// Active or sold, never removed. Re-selected when the listing's text or price
// changed since extraction (source_hash differs); listings.updated_at is not
// used because rechecks bump it whether anything changed or not.
export async function getRealEstateCandidates(db: DbClient, limit: number): Promise<RealEstateCandidate[]> {
  const result = (await db.query(
    `SELECT l.id, l.title, l.description, l.price_amount, ${SOURCE_HASH_SQL} AS source_hash
     FROM listings l
     JOIN products p ON p.id = l.product_id
     JOIN categories c ON c.id = p.category_id AND c.name = 'Real Estate'
     LEFT JOIN real_estate_details d ON d.listing_id = l.id
     WHERE l.flagged_removed_at IS NULL
       AND (d.listing_id IS NULL OR d.source_hash IS DISTINCT FROM ${SOURCE_HASH_SQL})
     ORDER BY l.first_seen_at DESC
     LIMIT $1`,
    [limit],
  )) as { rows: Record<string, unknown>[] }
  return result.rows.map((r) => ({
    id: r.id as string,
    title: (r.title as string | null) ?? '',
    description: (r.description as string | null) ?? null,
    price_amount: r.price_amount === null || r.price_amount === undefined ? null : Number(r.price_amount),
    source_hash: r.source_hash as string,
  }))
}

export async function upsertRealEstateDetails(
  db: DbClient,
  listingId: string,
  f: RealEstateFields,
  model: string,
  sourceHash: string,
): Promise<void> {
  await db.query(
    `INSERT INTO real_estate_details
       (listing_id, listing_type, property_type, price_php, price_basis, lot_sqm, floor_sqm, bedrooms, bathrooms,
        project_name, area_text, tags, confidence, source_hash, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15)
     ON CONFLICT (listing_id) DO UPDATE SET
       listing_type = EXCLUDED.listing_type, property_type = EXCLUDED.property_type,
       price_php = EXCLUDED.price_php, price_basis = EXCLUDED.price_basis,
       lot_sqm = EXCLUDED.lot_sqm, floor_sqm = EXCLUDED.floor_sqm,
       bedrooms = EXCLUDED.bedrooms, bathrooms = EXCLUDED.bathrooms,
       project_name = EXCLUDED.project_name, area_text = EXCLUDED.area_text,
       tags = EXCLUDED.tags, confidence = EXCLUDED.confidence,
       source_hash = EXCLUDED.source_hash, model = EXCLUDED.model, extracted_at = now()`,
    [
      listingId,
      f.listing_type,
      f.property_type,
      f.price_php,
      f.price_basis,
      f.lot_sqm,
      f.floor_sqm,
      f.bedrooms,
      f.bathrooms,
      f.project_name,
      f.area_text,
      JSON.stringify(f.tags),
      f.confidence,
      sourceHash,
      model,
    ],
  )
}
