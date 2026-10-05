import type { DbClient, QueryClient } from './storage'

// Every operator-tunable worker/discount-policy knob, keyed the same way as
// the `settings` table (db/schema.sql) and the dashboard's Settings page.
// Values here are the fallback used only if a key is somehow missing from
// the table - schema.sql seeds every key on migration, so this is defensive,
// not the primary source once a DB has been migrated.
export const SETTING_DEFAULTS: Record<string, number> = {
  'collect.max_items_default': 100,
  'collect.soft_wall_timeout_ms': 5000,
  'collect.pacing_min_ms': 4000,
  'collect.pacing_max_ms': 10000,
  'collect.loop_delay_ms': 300000,
  'collect.re_keywords_enabled': 0,
  'collect.re_every_n_laps': 3,
  'collect.re_max_items': 50,

  'check_listings.loop_delay_ms': 60000,
  'check_listings.limit_default': 100,
  'check_listings.soft_wall_timeout_ms': 5000,
  'check_listings.pacing_min_ms': 2000,
  'check_listings.pacing_max_ms': 4000,
  'check_listings.re_recheck_min_days': 0,

  'extract_products.max_attempts': 5,
  'extract_products.retry_base_delay_ms': 30000,
  'extract_products.loop_delay_ms': 300000,
  'extract_products.batch_size': 100,
  'extract_products.inter_batch_delay_ms': 5000,

  'enrich_products.batch_size': 20,
  'enrich_products.loop_delay_ms': 300000,
  'enrich_products.max_attempts': 3,
  'enrich_products.retry_delay_ms': 3000,

  'price_lookup.lap_limit_default': 20,
  'price_lookup.loop_delay_ms': 300000,
  'price_lookup.pacing_delay_ms': 1000,

  'enrich_listing_prices.batch_size': 35,
  'enrich_listing_prices.loop_delay_ms': 300000,

  'extract_real_estate.batch_size': 10,
  'extract_real_estate.loop_delay_ms': 300000,

  'verify_discount.lap_limit_default': 3,
  'verify_discount.fetch_batch_size': 50,
  'verify_discount.loop_delay_ms': 30000,
  'verify_discount.pacing_delay_ms': 1000,

  'discount_policy.high_discount_threshold_percent': 30,
  'discount_policy.min_profit_pesos': 1000,
  'discount_policy.min_price_pesos': 500,
  'discount_policy.gemini_daily_grounding_cap': 1000,
}

// Workers call this fresh every lap (not once at startup) so an operator's
// dashboard edit takes effect on the next lap, no restart - same
// re-query-every-lap convention this codebase already uses for candidate
// rows (see check-listings.ts). Falls back per-key to SETTING_DEFAULTS
// rather than throwing on a missing row.
export async function loadSettings(db: DbClient, keys: string[]): Promise<Record<string, number>> {
  const result = (await db.query('SELECT key, value FROM settings WHERE key = ANY($1)', [keys])) as {
    rows: { key: string; value: number }[]
  }
  const found = new Map(result.rows.map((row) => [row.key, row.value]))
  const settings: Record<string, number> = {}
  for (const key of keys) {
    settings[key] = found.get(key) ?? SETTING_DEFAULTS[key]
  }
  return settings
}

export interface SettingRow {
  key: string
  value: number
  updatedAt: string
}

// Every operator-tunable worker/discount-policy knob (see SETTING_DEFAULTS
// above for the full key list) - unfiltered, the dashboard Settings page
// groups these by key prefix itself.
export async function getAllSettings(db: QueryClient): Promise<SettingRow[]> {
  const result = await db.query(`SELECT key, value, updated_at FROM settings ORDER BY key`, [])
  return (result.rows as { key: string; value: number; updated_at: string }[]).map((r) => ({
    key: r.key,
    value: Number(r.value),
    updatedAt: r.updated_at,
  }))
}

// One batched UPDATE ... FROM (VALUES ...) rather than N single-row
// UPDATEs - a Settings-page section save can touch several keys at once,
// and this keeps that one round trip instead of N.
export async function updateSettings(db: QueryClient, updates: { key: string; value: number }[]): Promise<void> {
  if (updates.length === 0) return
  const valuesSql = updates.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}::integer)`).join(', ')
  const params = updates.flatMap((u) => [u.key, u.value])
  await db.query(
    `UPDATE settings SET value = v.value, updated_at = now()
     FROM (VALUES ${valuesSql}) AS v(key, value)
     WHERE settings.key = v.key`,
    params,
  )
}
