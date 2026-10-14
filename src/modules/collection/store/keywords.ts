import type { DbClient, QueryClient } from '../../../platform/storage'

// collect.ts's --cycle search-query list - editable via the Settings page's
// collect tab (add/remove rows, not per-field number knobs like the rest of
// settings, hence its own table/endpoint instead of a settings row).
export interface CollectKeyword {
  keyword: string
  enabled: boolean
}

export async function getCollectKeywords(db: QueryClient): Promise<CollectKeyword[]> {
  const result = await db.query(
    `SELECT keyword, enabled FROM collect_keywords WHERE kind = 'general' ORDER BY keyword`,
    [],
  )
  return (result.rows as CollectKeyword[]).map((r) => ({ keyword: r.keyword, enabled: r.enabled }))
}

// Full-list replace rather than a diffed add/remove - the table is a
// handful of rows edited rarely from one shared dashboard, so the simplicity
// of "save the whole list" outweighs the cost of a delete-then-insert.
export async function replaceCollectKeywords(db: QueryClient, keywords: CollectKeyword[]): Promise<void> {
  await db.query(`DELETE FROM collect_keywords WHERE kind = 'general'`, [])
  if (keywords.length === 0) return
  const valuesSql = keywords.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')
  const params = keywords.flatMap((k) => [k.keyword, k.enabled])
  await db.query(`INSERT INTO collect_keywords (keyword, enabled) VALUES ${valuesSql}`, params)
}

// The collection loop's general search terms. Selection only; the empty-table
// fallback is keywords.ts's decision.
export async function getEnabledGeneralKeywords(db: DbClient): Promise<string[]> {
  const result = (await db.query(
    "SELECT keyword FROM collect_keywords WHERE enabled AND kind = 'general' ORDER BY keyword",
    [],
  )) as { rows: { keyword: string }[] }
  return result.rows.map((r) => r.keyword)
}

export async function loadRealEstateKeywords(db: DbClient): Promise<string[]> {
  const result = (await db.query(
    "SELECT keyword FROM collect_keywords WHERE enabled AND kind = 'real_estate' ORDER BY keyword",
    [],
  )) as { rows: { keyword: string }[] }
  return result.rows.map((r) => r.keyword)
}
