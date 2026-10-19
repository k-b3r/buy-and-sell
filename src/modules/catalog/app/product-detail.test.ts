import { expect, test } from 'vitest'
import { getProductDetail } from './product-detail'
import type { QueryClient } from '../../../platform/storage'
import { peerListingSql } from '../../pricing'

function fakeDb(rows: Record<string, unknown>[]): QueryClient {
  return { query: async () => ({ rows }) }
}

test('getProductDetail returns null when the product does not exist', async () => {
  const db = fakeDb([])
  const result = await getProductDetail(db, 999)
  expect(result).toBeNull()
})

test('getProductDetail returns the product, its new/secondhand prices, and its listings', async () => {
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
              new_price_low: null,
              new_price_high: null,
              used_price_low: '15000',
              used_price_high: '20000',
              used_price_source: 'web_search',
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
      return {
        rows: [
          {
            id: '123',
            title: 'RTX 3060 OC Asus',
            price_amount: '15000',
            primary_photo_url: 'https://x/0.jpg',
            condition: 'Used - Like New',
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
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
    new_price_low: null,
    new_price_high: null,
    secondhand_price_low: 15000,
    secondhand_price_high: 20000,
    secondhand_price_source: 'web_search',
    best_discount_percent: null,
    discounted_listing_count: 0,
    discount_bands: [],
    pricing_excluded_reason: null,
    enrichment: null,
    listings: [
      {
        id: '123',
        title: 'RTX 3060 OC Asus',
        price_amount: 15000,
        primary_photo_url: 'https://x/0.jpg',
        condition: 'Used - Like New',
        sold_at: null,
        listed_at: null,
        price_review: null,
        discount_percent: null,
        reference_price: null,
        is_repost: false,
      },
    ],
  })
})

test('getProductDetail flags every listing that shares a normalized title with another, across the full set', async () => {
  let call = 0
  const listing = (id: string, title: string) => ({ id, title, price_amount: '15000', sold_at: null })
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) return { rows: [{ id: 1, base_model: 'RTX 3060', variant_tier: null }] }
      return {
        rows: [listing('a', 'RTX 3060 OC'), listing('b', 'Other GPU'), listing('c', '  rtx 3060 oc ')],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.listings.map((l) => [l.id, l.is_repost])).toEqual([
    ['a', true],
    ['b', false],
    ['c', true],
  ])
})

test("getProductDetail prefers a listing's stored_photo_urls over its primary_photo_url for the card thumbnail", async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 1,
              base_model: 'Sony WH-1000XM6',
              variant_tier: null,
              new_price_low: null,
              new_price_high: null,
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
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
      return {
        rows: [
          {
            id: '123',
            title: 'Sony WH-1000XM6',
            price_amount: '15000',
            // primary_photo_url is Facebook's own CDN link and expires;
            // stored_photo_urls is the durable R2-hosted copy and must win.
            primary_photo_url: 'https://scontent.fmnl30-3.fna.fbcdn.net/expired.jpg',
            stored_photo_urls: ['https://pub-xyz.r2.dev/listings/123/0.jpg'],
            condition: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
        ],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.listings[0].primary_photo_url).toBe('https://pub-xyz.r2.dev/listings/123/0.jpg')
})

test('getProductDetail surfaces the verification reasoning for a listing with a verified discount notification, null for one without', async () => {
  let call = 0
  let listingsSql = ''
  const db: QueryClient = {
    query: async (sql: string) => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 1,
              base_model: 'RTX 3060',
              variant_tier: null,
              new_price_low: null,
              new_price_high: null,
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
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
      listingsSql = sql
      return {
        rows: [
          {
            id: '123',
            title: 'flagged one',
            price_amount: '12000',
            condition: null,
            sold_at: null,
            verification_reasoning: 'Genuinely underpriced vs fresh market data.',
          },
          {
            id: '456',
            title: 'never flagged',
            price_amount: '13000',
            condition: null,
            sold_at: null,
            verification_reasoning: null,
          },
        ],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(listingsSql).toContain('dn.verification_reasoning')
  expect(listingsSql).toContain('dn.verified_at IS NOT NULL')
  expect(result?.listings.find((l) => l.id === '123')?.verification_reasoning).toBe(
    'Genuinely underpriced vs fresh market data.',
  )
  expect(result?.listings.find((l) => l.id === '456')?.verification_reasoning).toBeNull()
})

test("getProductDetail computes each listing's discount against the outlier-excluded median of its siblings", async () => {
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
              new_price_low: null,
              new_price_high: null,
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
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
      // Median of [12000, 15000, 18000, 999999999] before outlier exclusion is
      // pulled way up by the placeholder; the real market median is 15000.
      return {
        rows: [
          {
            id: 'a',
            title: 'A',
            price_amount: '12000',
            primary_photo_url: null,
            condition: null,
            sold_at: null,
            is_peer: true,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
          {
            id: 'b',
            title: 'B',
            price_amount: '15000',
            primary_photo_url: null,
            condition: null,
            sold_at: null,
            is_peer: true,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
          {
            id: 'c',
            title: 'C',
            price_amount: '18000',
            primary_photo_url: null,
            condition: null,
            sold_at: null,
            is_peer: true,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
          {
            id: 'd',
            title: 'D (swap only placeholder)',
            price_amount: '999999999',
            primary_photo_url: null,
            condition: null,
            sold_at: null,
            is_peer: true,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
          {
            id: 'e',
            title: 'E (fake attention price)',
            price_amount: '123456',
            primary_photo_url: null,
            condition: null,
            sold_at: null,
            is_peer: true,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
        ],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.listings.map((l) => [l.id, l.discount_percent, l.reference_price])).toEqual([
    ['a', 20, 15000],
    ['b', 0, 15000],
    ['c', -20, 15000],
    ['d', null, null],
    ['e', null, null],
  ])
  // 'd' is a magnitude outlier (999999999 vs a 15000 median) and 'e' is a
  // placeholder digit pattern (123456, an embedded ascending run) - both get
  // their price hidden entirely, matching enrich-listing-prices.ts's full
  // candidate criteria (magnitude outlier OR placeholder pattern), not just
  // the magnitude check.
  expect(result?.listings.map((l) => [l.id, l.price_amount])).toEqual([
    ['a', 12000],
    ['b', 15000],
    ['c', 18000],
    ['d', null],
    ['e', null],
  ])
})

test('getProductDetail takes the median over peer listings only, still scoring and showing a long-sold listing against it', async () => {
  let call = 0
  const listing = (id: string, price: string, isPeer: boolean) => ({
    id,
    title: id,
    price_amount: price,
    primary_photo_url: null,
    condition: null,
    sold_at: isPeer ? null : '2026-01-01T00:00:00Z',
    is_peer: isPeer,
    price_review_is_negotiable: null,
    price_review_low: null,
    price_review_high: null,
  })
  const db: QueryClient = {
    query: async (sql) => {
      call += 1
      if (call === 1) return { rows: [{ id: 1, base_model: 'RTX 3060', price_lookup_excluded: false }] }
      expect(sql).toContain(`${peerListingSql('l')} AS is_peer`)
      return {
        rows: [
          listing('a', '10000', true),
          listing('b', '10000', true),
          listing('c', '10000', true),
          listing('old1', '40000', false),
          listing('old2', '40000', false),
          listing('old3', '40000', false),
        ],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.listings.map((l) => [l.id, l.discount_percent, l.reference_price])).toEqual([
    ['a', 0, 10000],
    ['b', 0, 10000],
    ['c', 0, 10000],
    ['old1', -300, 10000],
    ['old2', -300, 10000],
    ['old3', -300, 10000],
  ])
})

test('getProductDetail suppresses discount computation entirely for a price_lookup_excluded product', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 429,
              base_model: 'Product',
              variant_tier: null,
              price_lookup_excluded: true,
              new_price_low: null,
              new_price_high: null,
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
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
      // Real listings that would otherwise produce real (if nonsensical,
      // since these are unrelated real items) discounts against each other.
      return {
        rows: [
          {
            id: 'a',
            title: 'Sale',
            price_amount: '1000',
            primary_photo_url: null,
            condition: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
          {
            id: 'b',
            title: 'Rush Sale',
            price_amount: '5000',
            primary_photo_url: null,
            condition: null,
            sold_at: null,
            price_review_is_negotiable: null,
            price_review_low: null,
            price_review_high: null,
          },
        ],
      }
    },
  }

  const result = await getProductDetail(db, 429)

  expect(result?.listings.every((l) => l.discount_percent === null)).toBe(true)
  expect(result?.best_discount_percent).toBeNull()
  expect(result?.discount_bands).toEqual([])
})

test('getProductDetail surfaces a brand-new Exa price separately from a Groq-trained secondhand fallback', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 310,
              base_model: 'iPhone 15',
              variant_tier: 'Plus',
              new_price_low: '68990',
              new_price_high: '89990',
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
              enrichment_description: 'desc',
              enrichment_value_drivers: 'drivers',
              enrichment_has_trained_price_knowledge: true,
              enrichment_trained_price_low: '35000',
              enrichment_trained_price_high: '40000',
              enrichment_trained_price_currency: 'PHP',
              enrichment_model: 'openai/gpt-oss-120b',
              enrichment_checked_at: new Date('2026-08-22T00:00:00.000Z'),
            },
          ],
        }
      }
      return { rows: [] }
    },
  }

  const result = await getProductDetail(db, 310)

  expect(result?.new_price_low).toBe(68990)
  expect(result?.new_price_high).toBe(89990)
  expect(result?.secondhand_price_low).toBe(35000)
  expect(result?.secondhand_price_high).toBe(40000)
  expect(result?.secondhand_price_source).toBe('groq_trained')
})

test('getProductDetail includes price_review on a listing when a listing_price_review row exists', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 1,
              base_model: 'RTX 2060',
              variant_tier: null,
              new_price_low: null,
              new_price_high: null,
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
            },
          ],
        }
      }
      return {
        rows: [
          {
            id: '1000000000000001',
            title: 'RTX 2060 6GB FOR SWAP ONLY',
            price_amount: '999999999',
            primary_photo_url: null,
            condition: 'Used - Good',
            sold_at: null,
            price_review_is_negotiable: true,
            price_review_low: '7500',
            price_review_high: '9000',
          },
        ],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result?.listings[0].price_review).toEqual({
    is_negotiable: true,
    price_low: 7500,
    price_high: 9000,
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
              new_price_low: null,
              new_price_high: null,
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
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
              new_price_low: null,
              new_price_high: null,
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
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
              new_price_low: null,
              new_price_high: null,
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
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

test('getProductDetail maps new prices and falls back to Groq-trained secondhand when no used price exists', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return {
          rows: [
            {
              id: 310,
              base_model: 'iPhone 15',
              variant_tier: 'Plus',
              new_price_low: '68990',
              new_price_high: '89990',
              used_price_low: null,
              used_price_high: null,
              used_price_source: null,
              enrichment_description: 'desc',
              enrichment_value_drivers: 'drivers',
              enrichment_has_trained_price_knowledge: true,
              enrichment_trained_price_low: '35000',
              enrichment_trained_price_high: '40000',
              enrichment_trained_price_currency: 'PHP',
              enrichment_model: 'openai/gpt-oss-120b',
              enrichment_checked_at: new Date('2026-08-22T00:00:00.000Z'),
            },
          ],
        }
      }
      return { rows: [] }
    },
  }

  const result = await getProductDetail(db, 310)

  expect(result?.new_price_low).toBe(68990)
  expect(result?.new_price_high).toBe(89990)
  expect(result?.secondhand_price_low).toBe(35000)
  expect(result?.secondhand_price_high).toBe(40000)
  expect(result?.secondhand_price_source).toBe('groq_trained')
})
