import type { DbClient } from '../../../platform/storage'
import {
  upsertListing,
  getCollectedListingIds,
  getCheckListingsCandidates,
  getListingCheckCandidatesForProduct,
  markListingAlive,
  markListingSold,
  flagListingRemoved,
  deleteListing,
  refreshListingFields,
  getBackfillCandidates,
  markListingPhotosUnavailable,
  getNegotiableKeywordCandidates,
  getPriceReviewCandidates,
  upsertListingPriceReview,
  upsertKeywordNegotiable,
} from './listings'

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

test('upsertListing runs the keyword scan and flags negotiable when the description matches', async () => {
  const { db, calls } = mockDb()

  await upsertListing(db, {
    id: '1',
    marketplace_listing_title: 'RTX 3060',
    listing_price: { amount: '15000', currency: 'PHP' },
    redacted_description: { text: 'Nego pa presyo, message me' },
  })

  expect(calls).toHaveLength(2)
  expect(calls[1].sql).toMatch(/^INSERT INTO listing_price_review/)
  expect(calls[1].params).toEqual(['1', 'keyword match: "nego"'])
})

test('upsertListing does not touch listing_price_review when nothing matches', async () => {
  const { db, calls } = mockDb()

  await upsertListing(db, {
    id: '1',
    marketplace_listing_title: 'RTX 3060',
    listing_price: { amount: '15000', currency: 'PHP' },
    redacted_description: { text: 'Barely used, comes with box.' },
  })

  expect(calls).toHaveLength(1)
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

test('refreshListingFields updates title/price/description/condition/raw_json, keyed by id', async () => {
  const { db, calls } = mockDb()
  const listing = {
    id: '12345',
    marketplace_listing_title: 'Sony WH-1000XM6 (price cut!)',
    listing_price: { amount: '13500.00', currency: 'PHP' },
    redacted_description: { text: 'Now negotiable, moving out soon.' },
    attribute_data: [{ label: 'Used - Fair', value: 'used_fair', attribute_name: 'Condition' }],
  }

  await refreshListingFields(db, listing)

  // Two calls: the field update, plus the keyword scan's price-review
  // upsert - the description says "Now negotiable", so it should fire.
  expect(calls).toHaveLength(2)
  expect(calls[0].sql).toMatch(/^UPDATE listings SET/)
  expect(calls[0].sql).not.toContain('primary_photo_url')
  expect(calls[0].sql).not.toContain('stored_photo_urls')
  const [id, title, priceAmount, priceCurrency, description, condition, rawJson] = calls[0].params
  expect(id).toBe('12345')
  expect(title).toBe('Sony WH-1000XM6 (price cut!)')
  expect(priceAmount).toBe(13500)
  expect(priceCurrency).toBe('PHP')
  expect(description).toBe('Now negotiable, moving out soon.')
  expect(condition).toBe('Used - Fair')
  expect(JSON.parse(rawJson as string)).toEqual(listing)

  expect(calls[1].sql).toContain('INSERT INTO listing_price_review')
  expect(calls[1].params).toEqual(['12345', 'keyword match: "negotiable"'])
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

test('getListingCheckCandidatesForProduct scopes to one product, excludes sold, orders oldest/never-checked first', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getListingCheckCandidatesForProduct(db, 42)

  expect(calls[0].sql).toContain('WHERE product_id = $1')
  expect(calls[0].sql).toContain('AND sold_at IS NULL')
  expect(calls[0].sql).toContain('ORDER BY last_checked_at ASC NULLS FIRST, listed_at ASC NULLS LAST')
  expect(calls[0].params).toEqual([42])
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

test('getPriceReviewCandidates also flags placeholder digit-pattern prices (123, 999, 12,567) regardless of magnitude', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getPriceReviewCandidates(db)

  // Same repeated-digit / ascending-run regex as the dashboard's
  // notPlaceholderPriceSql, applied both to exclude placeholders from the
  // median input and to flag a listing whose own price matches, independent
  // of the magnitude-outlier OR branch.
  expect(calls[0].sql).toContain("~ '^(\\d+)\\1+$'")
  expect(calls[0].sql).toContain("~ '012|123|234|345|456|567|678|789'")
  const occurrences = calls[0].sql.split("^(\\d+)\\1+$").length - 1
  expect(occurrences).toBe(2) // once excluding placeholders from the median, once flagging the listing itself
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

test('upsertKeywordNegotiable inserts is_negotiable=true with no price estimate, tagged as a keyword-scan match', async () => {
  const { db, calls } = mockDb()

  await upsertKeywordNegotiable(db, '123', 'nego')

  expect(calls[0].sql).toMatch(/^INSERT INTO listing_price_review/)
  expect(calls[0].sql).toContain('ON CONFLICT (listing_id) DO UPDATE')
  expect(calls[0].sql).not.toContain('price_low = EXCLUDED')
  expect(calls[0].sql).not.toContain('reasoning = EXCLUDED')
  expect(calls[0].params).toEqual(['123', 'keyword match: "nego"'])
})
