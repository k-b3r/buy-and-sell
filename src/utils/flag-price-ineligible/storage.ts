import type { DbClient } from '../../platform/storage'

// Manually curated categories (real estate, bare placeholders, parts with no
// single fixed price, services) — see db/schema.sql. Idempotent: matches on
// base_model text, safe to re-run as more junk categories turn up over time.
export async function flagPriceLookupExcluded(db: DbClient, baseModels: string[], reason: string): Promise<void> {
  await db.query(`UPDATE products SET price_lookup_excluded = true, price_lookup_excluded_reason = $1 WHERE base_model = ANY($2)`, [
    reason,
    baseModels,
  ])
}
