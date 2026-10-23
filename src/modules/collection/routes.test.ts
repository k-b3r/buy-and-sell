import express from 'express'
import request from 'supertest'
import { createCollectionRouter } from './routes'
import type { RouteCache } from '../../platform/cache'

function fakeDb(rows: unknown[] = []) {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params })
      return { rows }
    },
  }
}

// Runs every load and records the key/tags a read was cached under and the
// tags each mutation invalidated.
function fakeCache() {
  const wraps: { key: string; tags: string[] }[] = []
  const invalidated: string[][] = []
  const cache: RouteCache = {
    wrap: (key, tags, load) => {
      wraps.push({ key, tags })
      return load()
    },
    invalidate: (...tags) => {
      invalidated.push(tags)
    },
  }
  return { cache, wraps, invalidated }
}

function appWith(db: ReturnType<typeof fakeDb>, cache: RouteCache = fakeCache().cache) {
  const app = express()
  app.use(express.json())
  app.use(createCollectionRouter(db, cache))
  return app
}

test('GET /collect-keywords returns the stored keywords with their enabled flags', async () => {
  const db = fakeDb([{ keyword: 'iphone', enabled: true }])

  const res = await request(appWith(db)).get('/collect-keywords')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ keywords: [{ keyword: 'iphone', enabled: true }] })
})

test('PUT /collect-keywords saves the cleaned list and answers ok', async () => {
  const db = fakeDb()

  const res = await request(appWith(db))
    .put('/collect-keywords')
    .send({
      keywords: [
        { keyword: ' iPhone ', enabled: true },
        { keyword: 'iphone', enabled: false },
      ],
    })

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true })
  expect(JSON.stringify(db.calls.map((c) => c.params))).toContain('iphone')
  expect(JSON.stringify(db.calls.map((c) => c.params))).not.toContain(' iPhone ')
})

test('PUT /collect-keywords answers 400 with the validation message and writes nothing', async () => {
  const db = fakeDb()

  const empty = await request(appWith(db)).put('/collect-keywords').send({ keywords: [] })
  const allOff = await request(appWith(db))
    .put('/collect-keywords')
    .send({ keywords: [{ keyword: 'phone', enabled: false }] })

  expect(empty.status).toBe(400)
  expect(empty.body).toEqual({ error: 'keywords must be a non-empty array' })
  expect(allOff.status).toBe(400)
  expect(allOff.body).toEqual({ error: 'at least one keyword must be enabled' })
  expect(db.calls).toHaveLength(0)
})

test('PUT /collect-keywords answers 400 when the body has no keywords', async () => {
  const res = await request(appWith(fakeDb())).put('/collect-keywords').send({})

  expect(res.status).toBe(400)
  expect(res.body).toEqual({ error: 'keywords must be a non-empty array' })
})

const LISTING_ROW = {
  id: '123',
  title: 'Phone',
  price_amount: 1000,
  price_currency: 'PHP',
  description: null,
  condition: null,
  location_city: null,
  listed_at: null,
  primary_photo_url: null,
  stored_photo_urls: null,
  product_id: 7,
  base_model: null,
  variant_tier: null,
  is_saved: false,
}

test('GET /listings/:id returns the listing wrapped in { listing }, cached under its listing tag', async () => {
  const db = fakeDb([LISTING_ROW])
  const { cache, wraps } = fakeCache()

  const res = await request(appWith(db, cache)).get('/listings/123')

  expect(res.status).toBe(200)
  expect(res.body.listing.id).toBe('123')
  expect(res.body.listing.product_id).toBe(7)
  expect(wraps).toEqual([{ key: 'listing:123', tags: ['listing:123'] }])
  expect(db.calls.some((c) => JSON.stringify(c.params).includes('123'))).toBe(true)
})

test('GET /listings/:id answers 200 { listing: null } for an unknown listing', async () => {
  const res = await request(appWith(fakeDb([]))).get('/listings/999')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ listing: null })
})

test('GET /saved-listings returns the saved list wrapped in { listings }, cached under the saved-listings tag', async () => {
  const db = fakeDb([
    {
      id: '123',
      title: 'Phone',
      price_amount: 1000,
      primary_photo_url: null,
      stored_photo_urls: null,
      condition: null,
      sold_at: null,
      product_id: 7,
      base_model: null,
      variant_tier: null,
      saved_at: '2026-10-01T00:00:00.000Z',
    },
  ])
  const { cache, wraps } = fakeCache()

  const res = await request(appWith(db, cache)).get('/saved-listings')

  expect(res.status).toBe(200)
  expect(res.body.listings).toHaveLength(1)
  expect(res.body.listings[0].id).toBe('123')
  expect(wraps).toEqual([{ key: 'saved-listings', tags: ['saved-listings'] }])
})

test('POST /listings/:id/save inserts the bookmark and invalidates the listing, saved list and product tags', async () => {
  const db = fakeDb()
  const { cache, invalidated } = fakeCache()

  const res = await request(appWith(db, cache)).post('/listings/123/save?productId=7')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ saved: true })
  expect(db.calls).toHaveLength(1)
  expect(db.calls[0].sql).toContain('INSERT INTO saved_listings')
  expect(db.calls[0].params).toEqual(['123'])
  expect(invalidated).toEqual([['listing:123', 'saved-listings', 'product:7']])
})

test('DELETE /listings/:id/save removes the bookmark and skips the product tag when no productId is given', async () => {
  const db = fakeDb()
  const { cache, invalidated } = fakeCache()

  const res = await request(appWith(db, cache)).delete('/listings/123/save')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ saved: false })
  expect(db.calls[0].sql).toContain('DELETE FROM saved_listings')
  expect(db.calls[0].params).toEqual(['123'])
  expect(invalidated).toEqual([['listing:123', 'saved-listings']])
})

test('POST /listings/:id/save answers 400 for a bad productId and writes nothing', async () => {
  const db = fakeDb()
  const { cache, invalidated } = fakeCache()

  const res = await request(appWith(db, cache)).post('/listings/123/save?productId=abc')

  expect(res.status).toBe(400)
  expect(res.body).toEqual({ error: 'productId must be a positive integer' })
  expect(db.calls).toHaveLength(0)
  expect(invalidated).toHaveLength(0)
})
