import { getNegotiableKeywordCandidates } from './storage'

test('getNegotiableKeywordCandidates returns listings not already flagged negotiable', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [{ id: '1', title: 'RTX 3060', description: 'nego pa' }] }
    },
  }

  const result = await getNegotiableKeywordCandidates(db)

  expect(calls[0].sql).toContain('NOT EXISTS')
  expect(calls[0].sql).toContain('is_negotiable = true')
  expect(result).toEqual([{ id: '1', title: 'RTX 3060', description: 'nego pa' }])
})
