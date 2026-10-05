import type { QueryClient } from '../src/platform/storage'

export interface SettingRow {
  key: string
  value: number
  updatedAt: string
}

// Every operator-tunable worker/discount-policy knob (see
// src/platform/settings.ts's SETTING_DEFAULTS for the full key list) -
// unfiltered, the dashboard Settings page groups these by key prefix itself.
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
