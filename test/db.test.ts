import type { DbClient } from '../src/db'
import {
  findOrCreateProduct,
  updateListingProductIds,
  upsertListing,
  insertPriceCheck,
  getCheckListingsCandidates,
  markListingAlive,
  flagListingRemoved,
  deleteListing,
  markListingSold,
  getEnrichmentCandidates,
  upsertProductEnrichment,
  getPriceReviewCandidates,
  upsertListingPriceReview,
  getCollectedListingIds,
  getExtractionCandidates,
  getBackfillCandidates,
  markListingPhotosUnavailable,
  getNewPriceCandidates,
  flagPriceLookupExcluded,
} from '../src/db'

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

test('upsertListing extracts known fields and stores the full raw object as json', async () => {
  const { db, calls } = mockDb()
  const listing = {
    id: '12345',
    marketplace_listing_title: 'Sony WH-1000XM6',
    listing_price: { amount: '15500.00', currency: 'PHP' },
    redacted_description: { text: 'Barely used, comes with case.' },
    attribute_data: [
      { label: 'Used - Good', value: 'used_good', attribute_name: 'Condition' },
      { label: 'Sony', value: 'Sony', attribute_name: 'Brand' },
    ],
    marketplace_listing_category_id: '1792291877663080',
    location: { latitude: 14.33, longitude: 120.94, reverse_geocode: { city: 'Dasmariñas' } },
    primary_listing_photo: { image: { uri: 'https://scontent.example/photo.jpg' } },
    creation_time: 1786660802,
  }

  await upsertListing(db, listing)

  expect(calls).toHaveLength(1)
  const [
    id, title, priceAmount, priceCurrency, description, condition, categoryId, lat, lng, city,
    photoUrl, storedPhotoUrls, listedAt, rawJson,
  ] = calls[0].params

  expect(id).toBe('12345')
  expect(title).toBe('Sony WH-1000XM6')
  expect(priceAmount).toBe(15500)
  expect(priceCurrency).toBe('PHP')
  expect(description).toBe('Barely used, comes with case.')
  expect(condition).toBe('Used - Good')
  expect(categoryId).toBe('1792291877663080')
  expect(lat).toBe(14.33)
  expect(lng).toBe(120.94)
  expect(city).toBe('Dasmariñas')
  expect(photoUrl).toBe('https://scontent.example/photo.jpg')
  expect(storedPhotoUrls).toBeNull()
  expect((listedAt as Date).getTime()).toBe(1786660802 * 1000)
  expect(JSON.parse(rawJson as string)).toEqual(listing)
})

test('upsertListing extracts condition from attribute_data, not a top-level field', async () => {
  const { db, calls } = mockDb()
  await upsertListing(db, {
    id: '1',
    marketplace_listing_title: 'Test',
    attribute_data: [
      { label: 'Brand', value: 'Sony', attribute_name: 'Brand' },
      { label: 'New', value: 'new', attribute_name: 'Condition' },
    ],
  })

  expect(calls[0].params[5]).toBe('New')
})

test('upsertListing sets condition to null when attribute_data has no Condition entry', async () => {
  const { db, calls } = mockDb()
  await upsertListing(db, {
    id: '1',
    marketplace_listing_title: 'Test',
    attribute_data: [{ label: 'Sony', value: 'Sony', attribute_name: 'Brand' }],
  })

  expect(calls[0].params[5]).toBeNull()
})

test('upsertListing stores re-hosted photo URLs as a json array', async () => {
  const { db, calls } = mockDb()
  const listing = {
    id: '12345',
    marketplace_listing_title: 'Sony WH-1000XM6',
    stored_photo_urls: ['https://images.example.com/listings/12345/0.jpg', 'https://images.example.com/listings/12345/1.jpg'],
  }

  await upsertListing(db, listing)

  const storedPhotoUrls = calls[0].params[11]
  expect(JSON.parse(storedPhotoUrls as string)).toEqual(listing.stored_photo_urls)
})

test('upsertListing fills missing optional fields with null instead of throwing', async () => {
  const { db, calls } = mockDb()
  const listing = { id: '999', marketplace_listing_title: 'Bare Listing' }

  await upsertListing(db, listing)

  const params = calls[0].params
  expect(params[0]).toBe('999')
  expect(params[1]).toBe('Bare Listing')
  expect(params[2]).toBeNull()
  expect(params[3]).toBeNull()
  expect(params[4]).toBeNull()
  expect(params[5]).toBeNull()
  expect(params[6]).toBeNull()
  expect(params[7]).toBeNull()
  expect(params[8]).toBeNull()
  expect(params[9]).toBeNull()
  expect(params[10]).toBeNull()
  expect(params[11]).toBeNull()
})

test('upsertListing falls back to custom_title when marketplace_listing_title is absent', async () => {
  const { db, calls } = mockDb()
  await upsertListing(db, { id: '1', custom_title: 'Custom Name' })
  expect(calls[0].params[1]).toBe('Custom Name')
})

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
  expect(calls[1].params).toEqual(['RTX 3060', 'rtx 3060', null, null])
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
  expect(calls[1].params).toEqual(['RTX 3060', 'rtx 3060', "Founder's edition", 'founders edition'])
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

test('insertPriceCheck writes a new price_history row for the product, not an upsert', async () => {
  const { db, calls } = mockDb()

  await insertPriceCheck(
    db,
    42,
    { low: 4500, high: 12000, currency: 'PHP' },
    'Full grounded answer text here.',
    'gemini_grounding',
  )

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toMatch(/^INSERT INTO product_price_history/)
  expect(calls[0].sql).not.toContain('ON CONFLICT')
  expect(calls[0].params).toEqual([42, 4500, 12000, 'PHP', 'Full grounded answer text here.', 'gemini_grounding', null])
})

test('insertPriceCheck tags a listing-derived price with the listing_prices source and a condition', async () => {
  const { db, calls } = mockDb()

  await insertPriceCheck(
    db,
    42,
    { low: 14999, high: 15000, currency: 'PHP' },
    'computed from 4 listings',
    'listing_prices',
    'Used - Good',
  )

  expect(calls[0].params).toEqual([42, 14999, 15000, 'PHP', 'computed from 4 listings', 'listing_prices', 'Used - Good'])
})

test('insertPriceCheck defaults condition to null when not given (e.g. a blended Gemini-grounded range)', async () => {
  const { db, calls } = mockDb()

  await insertPriceCheck(db, 42, { low: 14999, high: 15000, currency: 'PHP' }, 'text', 'gemini_grounding')

  expect(calls[0].params[6]).toBeNull()
})

test('getCheckListingsCandidates orders by last_checked_at then listed_at, oldest/never-checked first', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getCheckListingsCandidates(db, 50)

  expect(calls[0].sql).toContain('ORDER BY last_checked_at ASC NULLS FIRST, listed_at ASC NULLS LAST')
  expect(calls[0].sql).toContain('LIMIT $1')
  expect(calls[0].sql).toContain('WHERE sold_at IS NULL')
  expect(calls[0].params).toEqual([50])
})

test('markListingAlive sets last_checked_at and clears any removal flag and sold flag', async () => {
  const { db, calls } = mockDb()

  await markListingAlive(db, '123')

  expect(calls[0].sql).toMatch(/^UPDATE listings/)
  expect(calls[0].sql).toContain('last_checked_at = now()')
  expect(calls[0].sql).toContain('flagged_removed_at = NULL')
  expect(calls[0].sql).toContain('sold_at = NULL')
  expect(calls[0].params).toEqual(['123'])
})

test('markListingSold sets sold_at and last_checked_at', async () => {
  const { db, calls } = mockDb()

  await markListingSold(db, '123')

  expect(calls[0].sql).toMatch(/^UPDATE listings/)
  expect(calls[0].sql).toContain('sold_at = now()')
  expect(calls[0].sql).toContain('last_checked_at = now()')
  expect(calls[0].params).toEqual(['123'])
})

test('flagListingRemoved sets both flagged_removed_at and last_checked_at, does not delete', async () => {
  const { db, calls } = mockDb()

  await flagListingRemoved(db, '123')

  expect(calls[0].sql).toMatch(/^UPDATE listings/)
  expect(calls[0].sql).toContain('flagged_removed_at = now()')
  expect(calls[0].sql).toContain('last_checked_at = now()')
  expect(calls[0].params).toEqual(['123'])
})

test('deleteListing removes the row by id', async () => {
  const { db, calls } = mockDb()

  await deleteListing(db, '123')

  expect(calls[0].sql).toMatch(/^DELETE FROM listings/)
  expect(calls[0].params).toEqual(['123'])
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
            sibling_variants: ['(base, no variant)', 'Pro', 'Pro Max'],
          },
          { id: 17, base_model: 'RTX 2060', variant_tier: null, sibling_variants: [] },
        ],
      }
    },
  }

  const result = await getEnrichmentCandidates(db)

  expect(calls[0].sql).toContain('NOT EXISTS')
  expect(calls[0].sql).toContain('product_enrichment')
  expect(result).toEqual([
    {
      id: 363,
      base_model: 'iPhone 12',
      variant_tier: 'Mini',
      sibling_variants: ['(base, no variant)', 'Pro', 'Pro Max'],
    },
    { id: 17, base_model: 'RTX 2060', variant_tier: null, sibling_variants: [] },
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
    },
    'openai/gpt-oss-120b',
  )

  expect(calls[0].sql).toMatch(/^INSERT INTO product_enrichment/)
  expect(calls[0].sql).toContain('ON CONFLICT (product_id) DO UPDATE')
  expect(calls[0].params).toEqual([363, 'desc', 'drivers', true, 9000, 13000, 'PHP', 'openai/gpt-oss-120b'])
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
    },
    'openai/gpt-oss-120b',
  )

  expect(calls[0].params).toEqual([17, 'desc', 'drivers', false, null, null, null, 'openai/gpt-oss-120b'])
})

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
})

test('flagPriceLookupExcluded updates products matching any of the given base_model values', async () => {
  const { db, calls } = mockDb()

  await flagPriceLookupExcluded(db, ['Condo', 'House and Lot'], 'real_estate')

  expect(calls[0].sql).toMatch(/^UPDATE products SET price_lookup_excluded = true/)
  expect(calls[0].params).toEqual(['real_estate', ['Condo', 'House and Lot']])
})

test('getPriceReviewCandidates returns listings whose price is a magnitude outlier vs their product median, not yet reviewed', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return {
        rows: [
          {
            id: '1000000000000001',
            title: 'RTX 2060 6GB FOR SWAP ONLY',
            description: 'FOR SWAP SA RTX 3060, ADD AKO. REBALLED PO BUT WORKING AS INTENDED.',
            price_amount: '999999999',
          },
        ],
      }
    },
  }

  const result = await getPriceReviewCandidates(db)

  expect(calls[0].sql).toContain('percentile_cont(0.5)')
  expect(calls[0].sql).toContain('NOT EXISTS')
  expect(calls[0].sql).toContain('listing_price_review')
  expect(result).toEqual([
    {
      id: '1000000000000001',
      title: 'RTX 2060 6GB FOR SWAP ONLY',
      description: 'FOR SWAP SA RTX 3060, ADD AKO. REBALLED PO BUT WORKING AS INTENDED.',
      price_amount: 999999999,
    },
  ])
})

test('upsertListingPriceReview inserts is_negotiable, price range, reasoning, and model', async () => {
  const { db, calls } = mockDb()

  await upsertListingPriceReview(
    db,
    '1000000000000001',
    { isNegotiable: true, priceLow: 7500, priceHigh: 9000, reasoning: 'Swap-only listing, real price is negotiable per description.' },
    'openai/gpt-oss-120b',
  )

  expect(calls[0].sql).toMatch(/^INSERT INTO listing_price_review/)
  expect(calls[0].sql).toContain('ON CONFLICT (listing_id) DO UPDATE')
  expect(calls[0].params).toEqual([
    '1000000000000001',
    true,
    7500,
    9000,
    'Swap-only listing, real price is negotiable per description.',
    'openai/gpt-oss-120b',
  ])
})

test('upsertListingPriceReview stores null price range when no real price could be determined', async () => {
  const { db, calls } = mockDb()

  await upsertListingPriceReview(
    db,
    '123',
    { isNegotiable: false, priceLow: null, priceHigh: null, reasoning: 'No price mentioned anywhere in the text.' },
    'openai/gpt-oss-120b',
  )

  expect(calls[0].params).toEqual(['123', false, null, null, 'No price mentioned anywhere in the text.', 'openai/gpt-oss-120b'])
})

test('getCollectedListingIds returns every listing id as a Set, for dedup during collection', async () => {
  const db = {
    query: async (sql: string) => {
      expect(sql).toBe('SELECT id FROM listings')
      return { rows: [{ id: '1' }, { id: '2' }] }
    },
  }

  const result = await getCollectedListingIds(db)

  expect(result).toBeInstanceOf(Set)
  expect([...result]).toEqual(['1', '2'])
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

test('getBackfillCandidates returns listings without stored photos, with their raw_json', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const rawListing = { id: '1', marketplace_listing_title: 'Mic' }
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [{ id: '1', raw_json: rawListing }] }
    },
  }

  const result = await getBackfillCandidates(db)

  expect(calls[0].sql).toContain('WHERE stored_photo_urls IS NULL')
  expect(result).toEqual([{ id: '1', raw_json: rawListing }])
})

test('markListingPhotosUnavailable sets stored_photo_urls to an empty array', async () => {
  const { db, calls } = mockDb()

  await markListingPhotosUnavailable(db, '123')

  expect(calls[0].sql).toMatch(/^UPDATE listings/)
  expect(calls[0].sql).toContain('stored_photo_urls')
  expect(calls[0].params).toEqual(['123'])
})
