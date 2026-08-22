import { expect, test } from 'vitest'
import { getProductSummaries, getProductDetail, getListingDetail } from '../src/lib/queries'
import type { QueryClient } from '../src/lib/queries'

function fakeDb(rows: Record<string, unknown>[]): QueryClient {
  return { query: async () => ({ rows }) }
}

test('getProductSummaries maps rows into ProductSummary shape with numeric fields coerced', async () => {
  const db = fakeDb([
    {
      id: 1,
      base_model: 'RTX 3060',
      variant_tier: null,
      listing_count: '8',
      price_min: '12000',
      price_max: '18500',
      price_avg: '15250.5',
      sample_photo_url: 'https://x/0.jpg',
      market_price_low: '15000',
      market_price_high: '20000',
      market_price_source: 'web_search',
    },
    {
      id: 2,
      base_model: 'iPhone 13',
      variant_tier: '128GB',
      listing_count: '3',
      price_min: null,
      price_max: null,
      price_avg: null,
      sample_photo_url: null,
      market_price_low: null,
      market_price_high: null,
      market_price_source: null,
    },
  ])

  const result = await getProductSummaries(db)

  expect(result).toEqual([
    {
      id: 1,
      base_model: 'RTX 3060',
      variant_tier: null,
      listing_count: 8,
      price_min: 12000,
      price_max: 18500,
      price_avg: 15250.5,
      sample_photo_url: 'https://x/0.jpg',
      market_price_low: 15000,
      market_price_high: 20000,
      market_price_source: 'web_search',
    },
    {
      id: 2,
      base_model: 'iPhone 13',
      variant_tier: '128GB',
      listing_count: 3,
      price_min: null,
      price_max: null,
      price_avg: null,
      sample_photo_url: null,
      market_price_low: null,
      market_price_high: null,
      market_price_source: null,
    },
  ])
})

test('getProductSummaries defaults to limit 30, offset 0, no search filter', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaries(db)

  expect(capturedParams).toEqual([null, 30, 0])
})

test('getProductSummaries passes search as an ILIKE pattern and respects offset/limit options', async () => {
  let capturedSql = ''
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaries(db, { search: 'RTX', offset: 60, limit: 10 })

  expect(capturedSql).toContain('ILIKE')
  expect(capturedParams).toEqual(['%RTX%', 10, 60])
})

test('getProductSummaries treats an empty/whitespace search as no filter', async () => {
  let capturedParams: unknown[] = []
  const db: QueryClient = {
    query: async (_sql, params) => {
      capturedParams = params
      return { rows: [] }
    },
  }

  await getProductSummaries(db, { search: '   ' })

  expect(capturedParams).toEqual([null, 30, 0])
})

test('getProductDetail returns null when the product does not exist', async () => {
  const db = fakeDb([])
  const result = await getProductDetail(db, 999)
  expect(result).toBeNull()
})

test('getProductDetail returns the product, its market price, and its listings', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 1,
              base_model: 'RTX 3060',
              variant_tier: null,
              market_price_low: '15000',
              market_price_high: '20000',
              market_price_source: 'web_search',
            },
          ],
        }
      }
      return {
        rows: [
          {
            id: '123',
            title: 'RTX 3060 OC Asus',
            price_amount: '15000',
            primary_photo_url: 'https://x/0.jpg',
            condition: 'Used - Like New',
            sold_at: null,
          },
        ],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result).toEqual({
    id: 1,
    base_model: 'RTX 3060',
    variant_tier: null,
    market_price_low: 15000,
    market_price_high: 20000,
    market_price_source: 'web_search',
    enrichment: null,
    listings: [
      {
        id: '123',
        title: 'RTX 3060 OC Asus',
        price_amount: 15000,
        primary_photo_url: 'https://x/0.jpg',
        condition: 'Used - Like New',
        sold_at: null,
      },
    ],
  })
})

test('getProductDetail marks a listing sold when its sold_at is set', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 1,
              base_model: 'RTX 3060',
              variant_tier: null,
              market_price_low: null,
              market_price_high: null,
              market_price_source: null,
            },
          ],
        }
      }
      return {
        rows: [
          {
            id: '123',
            title: 'RTX 3060 OC Asus',
            price_amount: '15000',
            primary_photo_url: 'https://x/0.jpg',
            condition: 'Used - Like New',
            sold_at: new Date('2026-08-22T00:00:00.000Z'),
          },
        ],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.listings[0].sold_at).toBe('2026-08-22T00:00:00.000Z')
})

test('getProductDetail includes enrichment when a product_enrichment row exists', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 1,
              base_model: 'RTX 3060',
              variant_tier: null,
              market_price_low: null,
              market_price_high: null,
              market_price_source: null,
              enrichment_description: 'A mid-range GPU popular for 1080p gaming.',
              enrichment_value_drivers: 'VRAM size, boost clock, cooler quality',
              enrichment_has_trained_price_knowledge: true,
              enrichment_trained_price_low: '9000',
              enrichment_trained_price_high: '13000',
              enrichment_trained_price_currency: 'PHP',
              enrichment_model: 'llama-3.1-8b-instant',
              enrichment_checked_at: new Date('2026-08-21T00:00:00.000Z'),
            },
          ],
        }
      }
      return { rows: [] }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.enrichment).toEqual({
    description: 'A mid-range GPU popular for 1080p gaming.',
    value_drivers: 'VRAM size, boost clock, cooler quality',
    has_trained_price_knowledge: true,
    trained_price_low: 9000,
    trained_price_high: 13000,
    trained_price_currency: 'PHP',
    model: 'llama-3.1-8b-instant',
    checked_at: '2026-08-21T00:00:00.000Z',
  })
})

test('getProductDetail returns null enrichment when no product_enrichment row exists', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 1,
              base_model: 'RTX 3060',
              variant_tier: null,
              market_price_low: null,
              market_price_high: null,
              market_price_source: null,
              enrichment_description: null,
              enrichment_value_drivers: null,
              enrichment_has_trained_price_knowledge: null,
              enrichment_trained_price_low: null,
              enrichment_trained_price_high: null,
              enrichment_trained_price_currency: null,
              enrichment_model: null,
              enrichment_checked_at: null,
            },
          ],
        }
      }
      return { rows: [] }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.enrichment).toBeNull()
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
    photo_urls: ['https://x/0.jpg', 'https://x/1.jpg'],
    product_id: 1,
    base_model: 'RTX 3060',
    variant_tier: null,
    sold_at: null,
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
