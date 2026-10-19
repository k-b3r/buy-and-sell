import type { DbClient } from '../../../platform/storage'
import { selectCheckCandidates } from './check-candidates'
import type { CheckListingsCandidate } from '../store/listings'

const candidate = (id: string): CheckListingsCandidate => ({ id, flagged_removed_at: null, source_photo_ids: null })

// One fake DbClient for the three reads a single call can make, routed by a
// marker unique to each query's SQL (collection/store/listings.ts for the
// backlog and deal candidates, pricing/store/deals.ts for the deal ids).
function fakeDb(rows: { backlog: CheckListingsCandidate[]; dealIds?: string[]; deals?: CheckListingsCandidate[] }): {
  db: DbClient
  calls: { sql: string; params: unknown[] }[]
} {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        if (sql.includes('deal_deduped')) return { rows: (rows.dealIds ?? []).map((id) => ({ listing_id: id })) }
        if (sql.includes('id = ANY($1)')) return { rows: rows.deals ?? [] }
        return { rows: rows.backlog }
      },
    },
  }
}

const settings = {
  'check_listings.re_recheck_min_days': 7,
  'check_listings.deals_priority_enabled': 1,
  'check_listings.deals_recheck_min_hours': 24,
  'discount_policy.min_profit_pesos': 1000,
  'discount_policy.min_price_pesos': 500,
}

test('selectCheckCandidates returns only the backlog, at the given limit, when deals priority is off', async () => {
  const { db, calls } = fakeDb({ backlog: [candidate('a'), candidate('b')] })

  const selected = await selectCheckCandidates(db, { ...settings, 'check_listings.deals_priority_enabled': 0 }, 10)

  expect(selected.map((c) => c.id)).toEqual(['a', 'b'])
  expect(calls).toHaveLength(1)
  expect(calls[0].params).toEqual([10, 7])
})

test('selectCheckCandidates puts deals first, drops duplicates and caps at the limit when deals priority is on', async () => {
  const { db, calls } = fakeDb({
    backlog: [candidate('a'), candidate('d1'), candidate('b'), candidate('d3')],
    dealIds: ['d1', 'd2'],
    deals: [candidate('d1'), candidate('d2')],
  })

  const selected = await selectCheckCandidates(db, settings, 4)

  expect(selected.map((c) => c.id)).toEqual(['d1', 'd2', 'a', 'b'])
  const dealIdsCall = calls.find((c) => c.sql.includes('deal_deduped'))!
  expect(dealIdsCall.params).toEqual(expect.arrayContaining([1000, 500, 200]))
  const dealCandidatesCall = calls.find((c) => c.sql.includes('id = ANY($1)'))!
  expect(dealCandidatesCall.params).toEqual([['d1', 'd2'], 24])
})
