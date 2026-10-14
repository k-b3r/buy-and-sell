import type { DbClient } from '../../platform/storage'
import { getEnabledGeneralKeywords } from './store/keywords'

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
// list takes effect on the next lap. Disabled keywords are kept in the table
// but skipped here; the dashboard API refuses to save a list with none
// enabled, so the empty fallback below is only reachable via a manual DB edit.
export async function loadCollectKeywords(db: DbClient): Promise<string[]> {
  const keywords = await getEnabledGeneralKeywords(db)
  return keywords.length === 0 ? DEFAULT_COLLECT_KEYWORDS : keywords
}

// Real estate phrases only. No default fallback - an empty list just means no
// real estate pass, never a lap with zero queries (the general list guards that).
export { loadRealEstateKeywords } from './store/keywords'

export interface LapQuery {
  query: string
  maxItems: number
}

export interface LapPlanInput {
  general: string[]
  realEstate: string[]
  lap: number
  reEnabled: number
  reEveryNLaps: number
  reMaxItems: number
  defaultMaxItems: number
}

// General keywords always run first, in the same order and with the same cap
// as before. The real estate pass is appended only when the flag is on and the
// lap is due (lap 1, then every Nth) - so with the flag at its default of 0
// this returns exactly today's list.
export function planLapQueries(input: LapPlanInput): LapQuery[] {
  const plan: LapQuery[] = input.general.map((query) => ({ query, maxItems: input.defaultMaxItems }))
  const due =
    input.reEnabled >= 1 && input.realEstate.length > 0 && (input.lap - 1) % Math.max(1, input.reEveryNLaps) === 0
  if (due) plan.push(...input.realEstate.map((query) => ({ query, maxItems: input.reMaxItems })))
  return plan
}
