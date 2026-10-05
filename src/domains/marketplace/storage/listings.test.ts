import type { DbClient } from '../../../platform/storage'
import type { Logger } from '../../../platform/logger'
import type { ImageStore, FetchBytes, CompressImage } from '../../../platform/images'
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

function fakeLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: () => {},
  }
}

function fakeImageStore(): ImageStore & { puts: { key: string }[]; deletedPrefixes: string[] } {
  const puts: { key: string }[] = []
  const deletedPrefixes: string[] = []
  return {
    puts,
    deletedPrefixes,
    async put(key) {
      puts.push({ key })
      return `https://images.example.com/${key}`
    },
    async deleteAll(prefix) {
      deletedPrefixes.push(prefix)
    },
  }
}

const workingFetchBytes: FetchBytes = async () => ({ body: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' })
const failingFetchBytes: FetchBytes = async () => null
const identityCompress: CompressImage = async (body, contentType) => ({ body, contentType })

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
    id,
    title,
    priceAmount,
    priceCurrency,
    description,
    condition,
    categoryId,
    lat,
    lng,
    city,
    photoUrl,
    storedPhotoUrls,
    sourcePhotoIds,
    listedAt,
    rawJson,
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
  expect(sourcePhotoIds).toBeNull()
  expect((listedAt as Date).getTime()).toBe(1786660802 * 1000)
  expect(JSON.parse(rawJson as string)).toEqual(listing)
})

test('upsertListing stores photo ids from listing_photos as a json array, in carousel order', async () => {
  const { db, calls } = mockDb()
  const listing = {
    id: '12345',
    marketplace_listing_title: 'Sony WH-1000XM6',
    listing_photos: [{ id: 'photo-a' }, { id: 'photo-b' }],
  }

  await upsertListing(db, listing)

  expect(JSON.parse(calls[0].params[12] as string)).toEqual(['photo-a', 'photo-b'])
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
    stored_photo_urls: [
      'https://images.example.com/listings/12345/0.jpg',
      'https://images.example.com/listings/12345/1.jpg',
    ],
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
  expect(params[12]).toBeNull()
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

  await refreshListingFields(db, fakeImageStore(), fakeLogger(), null, listing)

  // Two calls: the field update, plus the keyword scan's price-review
  // upsert - the description says "Now negotiable", so it should fire.
  expect(calls).toHaveLength(2)
  expect(calls[0].sql).toMatch(/^UPDATE listings SET/)
  expect(calls[0].sql).not.toContain('primary_photo_url')
  expect(calls[0].sql).not.toContain('stored_photo_urls')
  expect(calls[0].sql).not.toContain('source_photo_ids')
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

test('refreshListingFields captures photo ids as a baseline on first sighting, without touching photos', async () => {
  const { db, calls } = mockDb()
  const store = fakeImageStore()
  const listing = {
    id: '12345',
    marketplace_listing_title: 'Sony WH-1000XM6',
    listing_photos: [{ id: 'photo-a' }, { id: 'photo-b' }],
  }

  await refreshListingFields(db, store, fakeLogger(), null, listing)

  expect(calls[0].sql).toContain('source_photo_ids = $8')
  expect(calls[0].sql).not.toContain('primary_photo_url')
  expect(calls[0].sql).not.toContain('stored_photo_urls')
  expect(JSON.parse(calls[0].params[7] as string)).toEqual(['photo-a', 'photo-b'])
  expect(store.puts).toEqual([])
  expect(store.deletedPrefixes).toEqual([])
})

test('refreshListingFields leaves photos untouched when the ids match the stored baseline', async () => {
  const { db, calls } = mockDb()
  const store = fakeImageStore()
  const listing = {
    id: '12345',
    marketplace_listing_title: 'Sony WH-1000XM6',
    listing_photos: [{ id: 'photo-a' }, { id: 'photo-b' }],
  }

  await refreshListingFields(db, store, fakeLogger(), ['photo-a', 'photo-b'], listing)

  expect(calls[0].sql).not.toContain('primary_photo_url')
  expect(calls[0].sql).not.toContain('stored_photo_urls')
  expect(calls[0].sql).not.toContain('source_photo_ids')
  expect(store.puts).toEqual([])
  expect(store.deletedPrefixes).toEqual([])
})

test('refreshListingFields re-fetches and re-uploads photos when the seller swapped them', async () => {
  const { db, calls } = mockDb()
  const store = fakeImageStore()
  const listing = {
    id: '12345',
    marketplace_listing_title: 'Sony WH-1000XM6',
    primary_listing_photo: { image: { uri: 'https://scontent.example/new-primary.jpg' } },
    listing_photos: [
      { id: 'photo-c', image: { uri: 'https://scontent.example/c.jpg' } },
      { id: 'photo-d', image: { uri: 'https://scontent.example/d.jpg' } },
    ],
  }

  await refreshListingFields(
    db,
    store,
    fakeLogger(),
    ['photo-a', 'photo-b'],
    listing,
    workingFetchBytes,
    identityCompress,
  )

  expect(store.deletedPrefixes).toEqual(['listings/12345/'])
  expect(store.puts).toEqual([{ key: 'listings/12345/0.jpg' }, { key: 'listings/12345/1.jpg' }])
  expect(calls[0].sql).toContain('primary_photo_url')
  expect(calls[0].sql).toContain('stored_photo_urls')
  expect(calls[0].sql).toContain('source_photo_ids')
  const primaryPhotoUrl = calls[0].params[7]
  const storedPhotoUrls = calls[0].params[8]
  const sourcePhotoIds = calls[0].params[9]
  expect(primaryPhotoUrl).toBe('https://scontent.example/new-primary.jpg')
  expect(JSON.parse(storedPhotoUrls as string)).toEqual([
    'https://images.example.com/listings/12345/0.jpg',
    'https://images.example.com/listings/12345/1.jpg',
  ])
  expect(JSON.parse(sourcePhotoIds as string)).toEqual(['photo-c', 'photo-d'])
})

test('refreshListingFields keeps the existing photos when a detected change fails to re-fetch entirely', async () => {
  const { db, calls } = mockDb()
  const store = fakeImageStore()
  const logger = fakeLogger()
  const listing = {
    id: '12345',
    marketplace_listing_title: 'Sony WH-1000XM6',
    listing_photos: [{ id: 'photo-c', image: { uri: 'https://scontent.example/c.jpg' } }],
  }

  await refreshListingFields(db, store, logger, ['photo-a', 'photo-b'], listing, failingFetchBytes, identityCompress)

  expect(store.deletedPrefixes).toEqual(['listings/12345/'])
  expect(store.puts).toEqual([])
  expect(calls[0].sql).not.toContain('primary_photo_url')
  expect(calls[0].sql).not.toContain('stored_photo_urls')
  expect(calls[0].sql).not.toContain('source_photo_ids')
  expect(logger.warnings.some((w) => w.includes('returned nothing'))).toBe(true)
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

function historyDb(opts: {
  prior?: { old_price_amount: string | null; old_price_currency: string | null; old_first_seen_at: string }
  realEstate: boolean
  hasHistory: boolean
}): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        if (sql.startsWith('UPDATE listings SET')) return { rows: opts.prior ? [opts.prior] : [] }
        if (sql.includes('FROM listings l') && sql.includes("c.name = 'Real Estate'")) {
          return { rows: opts.realEstate ? [{ has_history: opts.hasHistory }] : [] }
        }
        return { rows: [] }
      },
    },
  }
}

const condoListing = (amount: string) => ({
  id: '12345',
  marketplace_listing_title: 'Condo for sale Makati',
  listing_price: { amount, currency: 'PHP' },
  redacted_description: { text: 'Nice unit near Ayala.' },
})

const priorRow = (amount: string | null) => ({
  old_price_amount: amount,
  old_price_currency: 'PHP',
  old_first_seen_at: '2026-08-20T00:00:00.000Z',
})

const historyInserts = (calls: { sql: string; params: unknown[] }[]) =>
  calls.filter((c) => c.sql.includes('INSERT INTO listing_price_history'))

test('refreshListingFields hands the prior price to real estate price history when the price changed', async () => {
  const { db, calls } = historyDb({ prior: priorRow('5000000.00'), realEstate: true, hasHistory: false })

  await refreshListingFields(db, fakeImageStore(), fakeLogger(), null, condoListing('4500000.00'))

  const inserts = historyInserts(calls)
  expect(inserts).toHaveLength(2)
  expect(inserts[0].params).toEqual(['12345', 5000000, 'PHP', '2026-08-20T00:00:00.000Z'])
  expect(inserts[1].params).toEqual(['12345', 4500000, 'PHP'])
})

test('getCheckListingsCandidates keeps the original query when reRecheckMinDays is 0', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getCheckListingsCandidates(db, 50, 0)

  expect(calls[0].sql).not.toContain('Real Estate')
  expect(calls[0].params).toEqual([50])
})

test('getCheckListingsCandidates skips recently checked real estate listings only when reRecheckMinDays > 0', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getCheckListingsCandidates(db, 50, 7)

  expect(calls[0].sql).toContain("c.name = 'Real Estate'")
  expect(calls[0].sql).toContain('l.sold_at IS NULL')
  expect(calls[0].sql).toContain('ORDER BY l.last_checked_at ASC NULLS FIRST, l.listed_at ASC NULLS LAST')
  expect(calls[0].params).toEqual([50, 7])
})
