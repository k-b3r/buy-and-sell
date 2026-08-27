import type { DbClient } from '../../platform/storage'
import { findOrCreateProduct, updateListingProductIds, getExtractionCandidates } from './storage'

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

test('findOrCreateProduct inserts a new product when none matches, returns its id', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  let queryCount = 0
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      queryCount += 1
      if (queryCount === 1) return { rows: [] } // SELECT finds nothing
      return { rows: [{ id: 42 }] } // INSERT ... RETURNING id
    },
  }

  const id = await findOrCreateProduct(db, 'RTX 3060', null)

  expect(id).toBe(42)
  expect(calls[0].sql).toMatch(/^SELECT/)
  expect(calls[0].params).toEqual(['rtx 3060', null])
  expect(calls[1].sql).toMatch(/^INSERT/)
  expect(calls[1].params).toEqual(['RTX 3060', 'rtx 3060', null, null, null])
})

test('findOrCreateProduct stores category on a newly-created product', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  let queryCount = 0
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      queryCount += 1
      if (queryCount === 1) return { rows: [] }
      return { rows: [{ id: 99 }] }
    },
  }

  const id = await findOrCreateProduct(db, 'RTX 3060', null, 'PC Components')

  expect(id).toBe(99)
  expect(calls[1].params).toEqual(['RTX 3060', 'rtx 3060', null, null, 'PC Components'])
})

test('findOrCreateProduct reuses an existing product when normalized base_model + variant_tier already match', async () => {
  const db = { query: async () => ({ rows: [{ id: 7 }] }) }

  const id = await findOrCreateProduct(db, '  RTX 3060  ', 'Custom AIB/OC')

  expect(id).toBe(7)
})

test('findOrCreateProduct dedupes variant_tier on a normalized column, keeping the raw text stored', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  let queryCount = 0
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      queryCount += 1
      if (queryCount === 1) return { rows: [] } // SELECT finds nothing
      return { rows: [{ id: 55 }] } // INSERT ... RETURNING id
    },
  }

  const id = await findOrCreateProduct(db, 'RTX 3060', "Founder's edition")

  expect(id).toBe(55)
  expect(calls[0].params).toEqual(['rtx 3060', 'founders edition'])
  expect(calls[1].params).toEqual(['RTX 3060', 'rtx 3060', "Founder's edition", 'founders edition', null])
})

test('findOrCreateProduct treats "Founders edition" and "Founder\'s edition" as the same product', async () => {
  const products: { id: number; normalized: string; variantNormalized: string | null }[] = []
  let nextId = 1
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT')) {
        const [normalized, variantNormalized] = params as [string, string | null]
        const match = products.find((p) => p.normalized === normalized && p.variantNormalized === variantNormalized)
        return { rows: match ? [{ id: match.id }] : [] }
      }
      const [, normalized, , variantNormalized] = params as [string, string, string, string | null]
      const id = nextId++
      products.push({ id, normalized, variantNormalized })
      return { rows: [{ id }] }
    },
  }

  const ocId = await findOrCreateProduct(db, 'RTX 3060', 'OC')
  const foundersId = await findOrCreateProduct(db, 'RTX 3060', 'Founders edition')
  const founderSApostropheId = await findOrCreateProduct(db, 'RTX 3060', "Founder's edition")

  expect(foundersId).toBe(founderSApostropheId)
  expect(ocId).not.toBe(foundersId)
})

test('updateListingProductIds does nothing (no query) when given an empty array', async () => {
  const { db, calls } = mockDb()

  await updateListingProductIds(db, [])

  expect(calls).toHaveLength(0)
})

test('updateListingProductIds issues a single multi-row UPDATE for all assignments', async () => {
  const { db, calls } = mockDb()

  await updateListingProductIds(db, [
    { id: '1', productId: 10 },
    { id: '2', productId: 20 },
    { id: '3', productId: 10 },
  ])

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toMatch(/^UPDATE listings/)
  expect(calls[0].sql).toContain('FROM (VALUES')
  expect(calls[0].params).toEqual(['1', 10, '2', 20, '3', 10])
})

test('getExtractionCandidates returns pending listings as id/title/description', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [{ id: '1', title: 'RTX 3060', description: 'for sale' }] }
    },
  }

  const result = await getExtractionCandidates(db)

  expect(calls[0].sql).toContain('WHERE product_id IS NULL')
  expect(result).toEqual([{ id: '1', title: 'RTX 3060', description: 'for sale' }])
})
