import type { DbClient } from './storage'

// Motivated-seller phrasing — these skew toward underpriced/urgent
// listings, the actual "buy-and-sell opportunity" signal this project is
// after, more than a plain product-name search does. Also the fallback if
// collect_keywords is somehow empty (defensive - schema.sql seeds these,
// not expected to hit once migrated) - collect must never run a lap with
// zero search queries.
export const DEFAULT_COLLECT_KEYWORDS = [
  'rush sale',
  'moving out',
  'preloved',
  'slightly used',
  'barely used',
  'decluttering',
  'upgrade',
  'for disposal',
]

// Loaded fresh every --cycle lap (not once at startup), same no-restart
// pattern as loadSettings - an operator's dashboard edit to the keyword
// list takes effect on the next lap.
export async function loadCollectKeywords(db: DbClient): Promise<string[]> {
  const result = (await db.query('SELECT keyword FROM collect_keywords ORDER BY keyword', [])) as {
    rows: { keyword: string }[]
  }
  if (result.rows.length === 0) return DEFAULT_COLLECT_KEYWORDS
  return result.rows.map((r) => r.keyword)
}
