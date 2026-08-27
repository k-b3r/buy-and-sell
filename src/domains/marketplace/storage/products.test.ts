import type { DbClient } from '../../../platform/storage'
import {
  findOrCreateProduct,
  updateListingProductIds,
  getExtractionCandidates,
  getEnrichmentCandidates,
  upsertProductEnrichment,
  applyEligibilityFromEnrichment,
  getCategoryBackfillCandidates,
  updateProductCategories,
  mergeDuplicateProduct,
  flagPriceLookupExcluded,
} from './products'

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

test('getEnrichmentCandidates returns products without an enrichment row, with sibling variant names', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return {
        rows: [
          {
            id: 363,
            base_model: 'iPhone 12',
            variant_tier: 'Mini',
            category: null,
            sibling_variants: ['(base, no variant)', 'Pro', 'Pro Max'],
          },
          { id: 17, base_model: 'RTX 2060', variant_tier: null, category: 'PC Components', sibling_variants: [] },
        ],
      }
    },
  }

  const result = await getEnrichmentCandidates(db)

  expect(calls[0].sql).toContain('NOT EXISTS')
  expect(calls[0].sql).toContain('product_enrichment')
  expect(calls[0].sql).toContain('categories')
  expect(result).toEqual([
    {
      id: 363,
      base_model: 'iPhone 12',
      variant_tier: 'Mini',
      category: null,
      sibling_variants: ['(base, no variant)', 'Pro', 'Pro Max'],
    },
    { id: 17, base_model: 'RTX 2060', variant_tier: null, category: 'PC Components', sibling_variants: [] },
  ])
})

test('upsertProductEnrichment inserts with PHP currency derived when a trained price is known', async () => {
  const { db, calls } = mockDb()

  await upsertProductEnrichment(
    db,
    363,
    {
      description: 'desc',
      valueDrivers: 'drivers',
      hasTrainedPriceKnowledge: true,
      trainedPriceLow: 9000,
      trainedPriceHigh: 13000,
      isSpecificProduct: true,
      confidence: 'high',
    },
    'openai/gpt-oss-120b',
  )

  expect(calls[0].sql).toMatch(/^INSERT INTO product_enrichment/)
  expect(calls[0].sql).toContain('ON CONFLICT (product_id) DO UPDATE')
  expect(calls[0].params).toEqual([363, 'desc', 'drivers', true, 9000, 13000, 'PHP', 'openai/gpt-oss-120b', true, 'high'])
})

test('upsertProductEnrichment stores null currency when no trained price is known', async () => {
  const { db, calls } = mockDb()

  await upsertProductEnrichment(
    db,
    17,
    {
      description: 'desc',
      valueDrivers: 'drivers',
      hasTrainedPriceKnowledge: false,
      trainedPriceLow: null,
      trainedPriceHigh: null,
      isSpecificProduct: false,
      confidence: 'low',
    },
    'openai/gpt-oss-120b',
  )

  expect(calls[0].params).toEqual([17, 'desc', 'drivers', false, null, null, null, 'openai/gpt-oss-120b', false, 'low'])
})

test('applyEligibilityFromEnrichment auto-excludes high-confidence non-specific products, then flags low-confidence ones for review', async () => {
  const { db, calls } = mockDb()

  await applyEligibilityFromEnrichment(db)

  expect(calls).toHaveLength(2)
  expect(calls[0].sql).toContain('UPDATE products p SET price_lookup_excluded = true')
  expect(calls[0].sql).toContain("price_lookup_excluded_reason = 'groq_generic'")
  expect(calls[0].sql).toContain("e.confidence = 'high'")
  expect(calls[0].sql).toContain('e.is_specific_product = false')
  expect(calls[0].sql).toContain('NOT p.price_lookup_excluded')
  expect(calls[1].sql).toContain("UPDATE products p SET price_lookup_review_status = 'needs_review'")
  expect(calls[1].sql).toContain("e.confidence = 'low'")
  expect(calls[1].sql).toContain('NOT p.price_lookup_excluded')
})

test('getCategoryBackfillCandidates returns products with no category assigned yet', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [{ id: 1, base_model: 'RTX 3060', variant_tier: null }] }
    },
  }

  const result = await getCategoryBackfillCandidates(db)

  expect(calls[0].sql).toContain('category_id IS NULL')
  expect(result).toEqual([{ id: 1, base_model: 'RTX 3060', variant_tier: null }])
})

test('updateProductCategories does nothing (no query) when given an empty array', async () => {
  const { db, calls } = mockDb()

  await updateProductCategories(db, [])

  expect(calls).toHaveLength(0)
})

test('updateProductCategories issues a single multi-row UPDATE for all assignments', async () => {
  const { db, calls } = mockDb()

  await updateProductCategories(db, [
    { id: 1, category: 'Gaming' },
    { id: 2, category: 'Audio' },
  ])

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toMatch(/^UPDATE products/)
  expect(calls[0].sql).toContain('FROM (VALUES')
  expect(calls[0].sql).toContain('JOIN categories')
  expect(calls[0].params).toEqual([1, 'Gaming', 2, 'Audio'])
})

test('mergeDuplicateProduct reassigns listings, price history, and enrichment (skipping it if the survivor already has one), then deletes the loser', async () => {
  const { db, calls } = mockDb()

  await mergeDuplicateProduct(db, 100, 200)

  expect(calls).toHaveLength(5)
  expect(calls[0].sql).toBe('UPDATE listings SET product_id = $1 WHERE product_id = $2')
  expect(calls[0].params).toEqual([100, 200])
  expect(calls[1].sql).toBe('UPDATE product_price_history SET product_id = $1 WHERE product_id = $2')
  expect(calls[1].params).toEqual([100, 200])
  expect(calls[2].sql).toContain('UPDATE product_enrichment SET product_id = $1')
  expect(calls[2].sql).toContain('NOT EXISTS')
  expect(calls[2].params).toEqual([100, 200])
  expect(calls[3].sql).toBe('DELETE FROM product_enrichment WHERE product_id = $1')
  expect(calls[3].params).toEqual([200])
  expect(calls[4].sql).toBe('DELETE FROM products WHERE id = $1')
  expect(calls[4].params).toEqual([200])
})

test('flagPriceLookupExcluded updates products matching any of the given base_model values', async () => {
  const { db, calls } = mockDb()

  await flagPriceLookupExcluded(db, ['Condo', 'House and Lot'], 'real_estate')

  expect(calls[0].sql).toMatch(/^UPDATE products SET price_lookup_excluded = true/)
  expect(calls[0].params).toEqual(['real_estate', ['Condo', 'House and Lot']])
})
