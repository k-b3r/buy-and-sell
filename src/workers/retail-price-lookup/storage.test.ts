import type { DbClient } from '../../storage/client'
import { getNewPriceCandidates, flagProductPriceLookupExcluded } from './storage'

function mockDb(): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return undefined
      },
    },
  }
}

test('getNewPriceCandidates skips a product with a price row from ANY source, not just exa_new_retail', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getNewPriceCandidates(db)

  expect(calls[0].sql).toContain('NOT EXISTS')
  expect(calls[0].sql).toContain('product_price_history')
  expect(calls[0].sql).not.toContain('source')
  expect(calls[0].sql).toContain('price_lookup_excluded')
  expect(calls[0].sql).toContain("price_lookup_review_status IS DISTINCT FROM 'needs_review'")
  expect(calls[0].sql).toContain('LEFT JOIN product_enrichment')
  expect(calls[0].sql).toContain('sibling_variants')
})

test('flagProductPriceLookupExcluded updates a single product by id', async () => {
  const { db, calls } = mockDb()

  await flagProductPriceLookupExcluded(db, 42, 'exa_no_result')

  expect(calls[0].sql).toMatch(/^UPDATE products SET price_lookup_excluded = true/)
  expect(calls[0].sql).toContain('WHERE id = $2')
  expect(calls[0].params).toEqual(['exa_no_result', 42])
})
