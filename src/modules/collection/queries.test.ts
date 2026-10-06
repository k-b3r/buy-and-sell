import { expect, test } from 'vitest'
import {
  getCollectKeywords,
  getListingDetail,
  getSavedListings,
  replaceCollectKeywords,
  saveListing,
  unsaveListing,
} from './queries'
import type { QueryClient } from '../../platform/storage'

function fakeDb(rows: Record<string, unknown>[]): QueryClient {
  return { query: async () => ({ rows }) }
}

test('getListingDetail excludes placeholder-pattern prices and price-lookup-excluded products from the sibling median query', async () => {
  const db: QueryClient = {
    query: async (sql: string) => {
      if (sql.includes('product_prices')) {
        expect(sql).toContain("'^(\\d+)\\1+$'")
        expect(sql).toContain('NOT p.price_lookup_excluded')
        return { rows: [{ raw_median_price: null, sample_size: '0', clean_median_price: null }] }
      }
      return {
        rows: [
          {
            id: '123',
            title: 'x',
            price_amount: '12000',
            price_currency: 'PHP',
            description: null,
            condition: null,
            location_city: null,
            listed_at: null,
            last_seen_at: null,
            primary_photo_url: null,
            stored_photo_urls: null,
            product_id: 1,
            base_model: null,
            variant_tier: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
        ],
      }
    },
  }

  await getListingDetail(db, '123')
})

test('getListingDetail hides price_amount entirely when it is a magnitude outlier vs. the sibling median', async () => {
  const db: QueryClient = {
    query: async (sql: string) => {
      if (sql.includes('product_prices')) {
        return { rows: [{ raw_median_price: '15000', sample_size: '5', clean_median_price: '15000' }] }
      }
      return {
        rows: [
          {
            id: '123',
            title: 'x',
            price_amount: '999999999',
            price_currency: 'PHP',
            description: null,
            condition: null,
            location_city: null,
            listed_at: null,
            last_seen_at: null,
            primary_photo_url: null,
            stored_photo_urls: null,
            product_id: 1,
            base_model: null,
            variant_tier: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
        ],
      }
    },
  }

  const result = await getListingDetail(db, '123')

  expect(result?.price_amount).toBeNull()
  expect(result?.discount_percent).toBeNull()
})

test('getListingDetail keeps a normal in-range price_amount as-is', async () => {
  const db: QueryClient = {
    query: async (sql: string) => {
      if (sql.includes('product_prices')) {
        return { rows: [{ raw_median_price: '15000', sample_size: '5', clean_median_price: '15000' }] }
      }
      return {
        rows: [
          {
            id: '123',
            title: 'x',
            price_amount: '12000',
            price_currency: 'PHP',
            description: null,
            condition: null,
            location_city: null,
            listed_at: null,
            last_seen_at: null,
            primary_photo_url: null,
            stored_photo_urls: null,
            product_id: 1,
            base_model: null,
            variant_tier: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
        ],
      }
    },
  }

  const result = await getListingDetail(db, '123')

  expect(result?.price_amount).toBe(12000)
})

test('getListingDetail surfaces the verification reasoning for a listing with a verified discount notification', async () => {
  let mainSql = ''
  const db: QueryClient = {
    query: async (sql: string) => {
      if (sql.includes('product_prices')) {
        return { rows: [{ raw_median_price: null, sample_size: '0', clean_median_price: null }] }
      }
      mainSql = sql
      return {
        rows: [
          {
            id: '123',
            title: 'x',
            price_amount: '12000',
            price_currency: 'PHP',
            description: null,
            condition: null,
            location_city: null,
            listed_at: null,
            last_seen_at: null,
            primary_photo_url: null,
            stored_photo_urls: null,
            product_id: 1,
            base_model: null,
            variant_tier: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
            verification_reasoning: 'Fresh market ~₱18k; the asking price genuinely undercuts it.',
          },
        ],
      }
    },
  }

  const result = await getListingDetail(db, '123')

  expect(mainSql).toContain('dn.verification_reasoning')
  expect(mainSql).toContain('dn.verified_at IS NOT NULL')
  expect(result?.verification_reasoning).toBe('Fresh market ~₱18k; the asking price genuinely undercuts it.')
})

test('getListingDetail returns null when the listing does not exist', async () => {
  const db = fakeDb([])
  const result = await getListingDetail(db, '999')
  expect(result).toBeNull()
})

test('getListingDetail maps a full row, preferring stored_photo_urls over primary_photo_url, and coerces a Date listed_at to an ISO string', async () => {
  const db = fakeDb([
    {
      id: '123',
      title: 'RTX 3060 OC Asus',
      price_amount: '15000',
      price_currency: 'PHP',
      description: 'Barely used',
      condition: 'Used - Like New',
      location_city: 'Quezon City',
      listed_at: new Date('2026-08-01T00:00:00.000Z'),
      primary_photo_url: 'https://x/primary.jpg',
      stored_photo_urls: ['https://x/0.jpg', 'https://x/1.jpg'],
      product_id: 1,
      base_model: 'RTX 3060',
      variant_tier: null,
      sold_at: null,
      price_review_is_negotiable: null,
      price_review_low: null,
      price_review_high: null,
    },
  ])

  const result = await getListingDetail(db, '123')

  expect(result).toEqual({
    id: '123',
    title: 'RTX 3060 OC Asus',
    price_amount: 15000,
    price_currency: 'PHP',
    description: 'Barely used',
    condition: 'Used - Like New',
    location_city: 'Quezon City',
    listed_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: null,
    photo_urls: ['https://x/0.jpg', 'https://x/1.jpg'],
    product_id: 1,
    base_model: 'RTX 3060',
    variant_tier: null,
    sold_at: null,
    discount_percent: null,
    reference_price: null,
    price_review: null,
    recent_sales: [],
    similar_listings: [],
  })
})

test("getListingDetail computes discount against its siblings' outlier-excluded median", async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: '123',
              title: 'RTX 3060 OC Asus',
              price_amount: '12000',
              price_currency: 'PHP',
              description: null,
              condition: null,
              location_city: null,
              listed_at: null,
              last_seen_at: null,
              primary_photo_url: null,
              stored_photo_urls: null,
              product_id: 1,
              base_model: 'RTX 3060',
              variant_tier: null,
              sold_at: null,
              price_review_is_negotiable: null,
              price_review_low: null,
              price_review_high: null,
            },
          ],
        }
      }
      return { rows: [{ raw_median_price: '15000', sample_size: '5', clean_median_price: '15000' }] }
    },
  }

  const result = await getListingDetail(db, '123')

  expect(result?.discount_percent).toBe(20)
  expect(result?.reference_price).toBe(15000)
})

test('getListingDetail still runs the sibling-median query (in parallel, keyed off listingId) when the listing has no product_id, and gets no discount back', async () => {
  let queryCount = 0
  const db: QueryClient = {
    query: async (sql: string) => {
      queryCount += 1
      if (sql.includes('product_prices'))
        return { rows: [{ raw_median_price: null, sample_size: '0', clean_median_price: null }] }
      return {
        rows: [
          {
            id: '124',
            title: 'Unmatched listing',
            price_amount: '5000',
            price_currency: 'PHP',
            description: null,
            condition: null,
            location_city: null,
            listed_at: null,
            last_seen_at: null,
            primary_photo_url: null,
            stored_photo_urls: null,
            product_id: null,
            base_model: null,
            variant_tier: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
        ],
      }
    },
  }

  const result = await getListingDetail(db, '124')

  expect(queryCount).toBe(2)
  expect(result?.discount_percent).toBeNull()
  expect(result?.recent_sales).toEqual([])
  expect(result?.similar_listings).toEqual([])
})

test('getListingDetail populates recent_sales/similar_listings only for tiers that clear their own sample threshold', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: '123',
              title: 'iPhone 13',
              price_amount: '10000',
              price_currency: 'PHP',
              description: null,
              condition: null,
              location_city: null,
              listed_at: null,
              last_seen_at: null,
              primary_photo_url: null,
              stored_photo_urls: null,
              product_id: 1,
              base_model: 'iPhone 13',
              variant_tier: null,
              sold_at: null,
              price_review_is_negotiable: null,
              price_review_low: null,
              price_review_high: null,
            },
          ],
        }
      }
      if (call === 2) return { rows: [{ raw_median_price: '12000', sample_size: '5', clean_median_price: '12000' }] } // sibling median
      if (call === 3) return { rows: [{ sample_size: '4', clean_median_price: '11000' }] } // getSoldComparablePrice: clears n>=3
      if (call === 4) return { rows: [{ sample_size: '1', clean_median_price: null }] } // getPeerMedianPrice: fails n>=3
      if (call === 5) {
        return {
          rows: [
            {
              listing_id: 'l2',
              title: 'Sold iPhone 13',
              price_amount: '11500',
              primary_photo_url: 'https://x/s.jpg',
              stored_photo_urls: null,
              date: new Date('2026-08-20T00:00:00Z'),
            },
          ],
        }
      }
      return { rows: [] } // call 6: peer comparable rows - unused, peer tier didn't clear its threshold
    },
  }

  const result = await getListingDetail(db, '123')

  expect(result?.recent_sales).toEqual([
    {
      listing_id: 'l2',
      title: 'Sold iPhone 13',
      price_amount: 11500,
      photo_url: 'https://x/s.jpg',
      date: '2026-08-20T00:00:00.000Z',
    },
  ])
  expect(result?.similar_listings).toEqual([])
})

test('getListingDetail includes price_review when a listing_price_review row exists', async () => {
  const db = fakeDb([
    {
      id: '1000000000000001',
      title: 'RTX 2060 6GB FOR SWAP ONLY',
      price_amount: '999999999',
      price_currency: 'PHP',
      description: 'swap only',
      condition: 'Used - Good',
      location_city: null,
      listed_at: null,
      primary_photo_url: null,
      stored_photo_urls: null,
      product_id: 17,
      base_model: 'RTX 2060',
      variant_tier: null,
      sold_at: null,
      price_review_is_negotiable: true,
      price_review_low: '7500',
      price_review_high: '9000',
    },
  ])

  const result = await getListingDetail(db, '1000000000000001')

  expect(result?.price_review).toEqual({
    is_negotiable: true,
    price_low: 7500,
    price_high: 9000,
  })
})

test('getListingDetail coerces a Date sold_at to an ISO string', async () => {
  const db = fakeDb([
    {
      id: '123',
      title: 'RTX 3060 OC Asus',
      price_amount: null,
      price_currency: null,
      description: null,
      condition: null,
      location_city: null,
      listed_at: null,
      primary_photo_url: null,
      stored_photo_urls: null,
      product_id: null,
      base_model: null,
      variant_tier: null,
      sold_at: new Date('2026-08-22T00:00:00.000Z'),
    },
  ])

  const result = await getListingDetail(db, '123')

  expect(result?.sold_at).toBe('2026-08-22T00:00:00.000Z')
})

test('getListingDetail falls back to primary_photo_url when stored_photo_urls is null or empty', async () => {
  const db = fakeDb([
    {
      id: '124',
      title: 'No carousel',
      price_amount: null,
      price_currency: null,
      description: null,
      condition: null,
      location_city: null,
      listed_at: null,
      primary_photo_url: 'https://x/primary.jpg',
      stored_photo_urls: null,
      product_id: null,
      base_model: null,
      variant_tier: null,
    },
  ])

  const result = await getListingDetail(db, '124')

  expect(result?.photo_urls).toEqual(['https://x/primary.jpg'])
})

test('getListingDetail returns an empty photo_urls array when neither is present', async () => {
  const db = fakeDb([
    {
      id: '125',
      title: 'No photos',
      price_amount: null,
      price_currency: null,
      description: null,
      condition: null,
      location_city: null,
      listed_at: null,
      primary_photo_url: null,
      stored_photo_urls: null,
      product_id: null,
      base_model: null,
      variant_tier: null,
    },
  ])

  const result = await getListingDetail(db, '125')

  expect(result?.photo_urls).toEqual([])
})

test('getListingDetail sets is_saved true when a saved_listings row exists', async () => {
  const db = fakeDb([
    {
      id: '123',
      title: 'x',
      price_amount: null,
      price_currency: null,
      description: null,
      condition: null,
      location_city: null,
      listed_at: null,
      primary_photo_url: null,
      stored_photo_urls: null,
      product_id: null,
      base_model: null,
      variant_tier: null,
      is_saved: true,
    },
  ])

  const result = await getListingDetail(db, '123')

  expect(result?.is_saved).toBe(true)
})

test('saveListing inserts into saved_listings, ignoring an already-saved listing', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await saveListing(db, '123')

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('INSERT INTO saved_listings')
  expect(calls[0].sql).toContain('ON CONFLICT (listing_id) DO NOTHING')
  expect(calls[0].params).toEqual(['123'])
})

test('unsaveListing deletes the saved_listings row for the given listing', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await unsaveListing(db, '123')

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('DELETE FROM saved_listings')
  expect(calls[0].params).toEqual(['123'])
})

test('getSavedListings maps joined rows into SavedListingSummary shape, most recently saved first', async () => {
  const db = fakeDb([
    {
      id: '123',
      title: 'Sony WH-1000XM6',
      price_amount: '15000',
      primary_photo_url: 'https://x/0.jpg',
      stored_photo_urls: null,
      condition: 'Used - like new',
      sold_at: null,
      product_id: 1,
      base_model: 'Sony WH-1000XM6',
      variant_tier: null,
      saved_at: '2026-08-25T00:00:00.000Z',
    },
  ])

  const result = await getSavedListings(db)

  expect(result).toEqual([
    {
      id: '123',
      title: 'Sony WH-1000XM6',
      price_amount: 15000,
      primary_photo_url: 'https://x/0.jpg',
      condition: 'Used - like new',
      sold_at: null,
      product_id: 1,
      base_model: 'Sony WH-1000XM6',
      variant_tier: null,
      saved_at: '2026-08-25T00:00:00.000Z',
    },
  ])
})

test('getSavedListings prefers stored_photo_urls over primary_photo_url', async () => {
  const db = fakeDb([
    {
      id: '123',
      title: 'x',
      price_amount: null,
      primary_photo_url: 'https://x/expired.jpg',
      stored_photo_urls: ['https://r2/0.jpg'],
      condition: null,
      sold_at: null,
      product_id: null,
      base_model: null,
      variant_tier: null,
      saved_at: '2026-08-25T00:00:00.000Z',
    },
  ])

  const result = await getSavedListings(db)

  expect(result[0].primary_photo_url).toBe('https://r2/0.jpg')
})

test('getCollectKeywords maps rows into keyword + enabled entries', async () => {
  const db: QueryClient = {
    query: async () => ({
      rows: [
        { keyword: 'moving out', enabled: true },
        { keyword: 'rush sale', enabled: false },
      ],
    }),
  }

  expect(await getCollectKeywords(db)).toEqual([
    { keyword: 'moving out', enabled: true },
    { keyword: 'rush sale', enabled: false },
  ])
})

test('replaceCollectKeywords deletes all rows then inserts the new list in one batch', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await replaceCollectKeywords(db, [
    { keyword: 'rush sale', enabled: true },
    { keyword: 'garage sale', enabled: false },
  ])

  expect(calls).toHaveLength(2)
  expect(calls[0].sql).toContain('DELETE FROM collect_keywords')
  expect(calls[1].sql).toContain('INSERT INTO collect_keywords')
  expect(calls[1].sql).toContain('enabled')
  expect(calls[1].params).toEqual(['rush sale', true, 'garage sale', false])
})

test('replaceCollectKeywords still deletes when the new list is empty, skips the insert', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await replaceCollectKeywords(db, [])

  expect(calls).toHaveLength(1)
  expect(calls[0].sql).toContain('DELETE FROM collect_keywords')
})

test('getCollectKeywords and replaceCollectKeywords only touch general keywords', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getCollectKeywords(db)
  await replaceCollectKeywords(db, [{ keyword: 'rush sale', enabled: true }])

  expect(calls[0].sql).toContain("kind = 'general'")
  expect(calls[1].sql).toContain("DELETE FROM collect_keywords WHERE kind = 'general'")
})
