import { expect, test } from 'vitest'
import { getProductDetailRows } from './product-detail'
import type { QueryClient } from '../../../platform/storage'
import { NEW_PRICE_LATERAL, peerListingSql, SECONDHAND_PRICE_LATERAL } from '../../pricing'

type Call = { sql: string; params: unknown[] }

function recordingDb(productRows: Record<string, unknown>[], listingRows: Record<string, unknown>[]) {
  const calls: Call[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: sql.includes('FROM products p') ? productRows : listingRows }
    },
  }
  return { db, calls }
}

test('getProductDetailRows runs the product query and the listings query, both keyed by the product id', async () => {
  const { db, calls } = recordingDb([{ id: 7, base_model: 'PlayStation 5' }], [])

  await getProductDetailRows(db, 7)

  expect(calls).toHaveLength(2)
  const [productCall, listingsCall] = calls
  expect(productCall.sql).toContain(NEW_PRICE_LATERAL)
  expect(productCall.sql).toContain(SECONDHAND_PRICE_LATERAL)
  expect(productCall.sql).toContain('WHERE p.id = $1')
  expect(productCall.params).toEqual([7])
  expect(listingsCall.sql).toContain(`${peerListingSql('l')} AS is_peer`)
  expect(listingsCall.sql).toContain('WHERE l.product_id = $1')
  expect(listingsCall.params).toEqual([7])
})

test('getProductDetailRows answers null when no product row matches', async () => {
  const { db } = recordingDb([], [{ id: 'l1' }])

  expect(await getProductDetailRows(db, 404)).toBeNull()
})

test('getProductDetailRows maps the product row, keeping the used and trained price fields raw for the caller to resolve', async () => {
  const { db } = recordingDb(
    [
      {
        id: 7,
        base_model: 'PlayStation 5',
        variant_tier: null,
        price_lookup_excluded: true,
        price_lookup_excluded_reason: null,
        new_price_low: '25000',
        new_price_high: '30000',
        used_price_low: null,
        used_price_high: null,
        used_price_source: null,
        enrichment_description: 'desc',
        enrichment_value_drivers: 'drivers',
        enrichment_has_trained_price_knowledge: true,
        enrichment_trained_price_low: '20000',
        enrichment_trained_price_high: '22000',
        enrichment_trained_price_currency: 'PHP',
        enrichment_model: 'openai/gpt-oss-120b',
        enrichment_checked_at: new Date('2026-08-22T00:00:00.000Z'),
      },
    ],
    [],
  )

  const result = await getProductDetailRows(db, 7)

  expect(result?.product).toMatchObject({
    id: 7,
    price_lookup_excluded: true,
    pricing_excluded_reason: 'unknown',
    new_price_low: 25000,
    new_price_high: 30000,
    used_price_low: null,
    has_trained_price_knowledge: true,
    trained_price_low: '20000',
    enrichment: {
      description: 'desc',
      trained_price_low: 20000,
      trained_price_high: 22000,
      checked_at: '2026-08-22T00:00:00.000Z',
    },
  })
})

test('getProductDetailRows maps listing rows: stored photo first, peer flag, saved flag, price review', async () => {
  const { db } = recordingDb(
    [{ id: 7, base_model: 'PlayStation 5' }],
    [
      {
        id: 'l1',
        title: 'PS5',
        price_amount: '30000',
        primary_photo_url: 'https://cdn/primary.jpg',
        stored_photo_urls: ['https://cdn/stored.jpg'],
        condition: 'used',
        sold_at: null,
        listed_at: new Date('2026-09-01T00:00:00.000Z'),
        is_peer: true,
        price_review_is_negotiable: true,
        price_review_low: '28000',
        price_review_high: null,
        is_saved: true,
        verification_reasoning: 'looks right',
      },
    ],
  )

  const result = await getProductDetailRows(db, 7)

  expect(result?.listings).toEqual([
    {
      id: 'l1',
      title: 'PS5',
      price_amount: 30000,
      primary_photo_url: 'https://cdn/stored.jpg',
      condition: 'used',
      sold_at: null,
      listed_at: '2026-09-01T00:00:00.000Z',
      price_review: { is_negotiable: true, price_low: 28000, price_high: null },
      is_saved: true,
      verification_reasoning: 'looks right',
      is_peer: true,
    },
  ])
})
