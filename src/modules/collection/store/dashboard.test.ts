import { expect, test } from 'vitest'
import {
  getListingDetailRow,
  getListingProductId,
  getSavedListings,
  getSiblingMedianRow,
  saveListing,
  unsaveListing,
} from './dashboard'
import type { QueryClient } from '../../../platform/storage'
import { peerListingSql } from '../../pricing'

function fakeDb(rows: Record<string, unknown>[]): QueryClient {
  return { query: async () => ({ rows }) }
}

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

test('getListingDetailRow selects the listing by id with its product, price review, saved and verification joins', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] })
      return { rows: [{ id: '123' }] }
    },
  }
  const row = await getListingDetailRow(db, '123')
  expect(row).toEqual({ id: '123' })
  expect(calls).toHaveLength(1)
  expect(calls[0].params).toEqual(['123'])
  for (const fragment of [
    'FROM listings l',
    'LEFT JOIN products p',
    'LEFT JOIN listing_price_review pr',
    'LEFT JOIN saved_listings sv',
    'LEFT JOIN discount_notifications dn',
    'WHERE l.id = $1',
  ]) {
    expect(calls[0].sql).toContain(fragment)
  }
})

test('getListingDetailRow returns undefined when the listing does not exist', async () => {
  expect(await getListingDetailRow(fakeDb([]), 'missing')).toBeUndefined()
})

test('getSiblingMedianRow keys the median off the listing id, over peer listings of non-excluded products', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] })
      return { rows: [{ raw_median_price: '100', sample_size: '3', clean_median_price: '100' }] }
    },
  }
  const row = await getSiblingMedianRow(db, '123')
  expect(row).toEqual({ raw_median_price: '100', sample_size: '3', clean_median_price: '100' })
  expect(calls[0].params).toEqual(['123'])
  expect(calls[0].sql).toContain('(SELECT product_id FROM listings WHERE id = $1)')
  expect(calls[0].sql).toContain('NOT p.price_lookup_excluded')
  expect(calls[0].sql).toContain(peerListingSql('l'))
})

test('getListingProductId returns the product id of the listing, or null when it has none or does not exist', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = (rows: Record<string, unknown>[]): QueryClient => ({
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] })
      return { rows }
    },
  })
  expect(await getListingProductId(db([{ product_id: 7 }]), '123')).toBe(7)
  expect(await getListingProductId(db([{ product_id: null }]), '123')).toBeNull()
  expect(await getListingProductId(db([]), 'missing')).toBeNull()
  expect(calls[0]).toEqual({ sql: 'SELECT product_id FROM listings WHERE id = $1', params: ['123'] })
})
