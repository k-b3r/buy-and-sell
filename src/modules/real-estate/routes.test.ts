import express from 'express'
import request from 'supertest'
import { createRealEstateRouter } from './routes'
import { REAL_ESTATE_PAGE_SIZE } from './domain/filters'

function fakeDb(rows: Record<string, unknown>[] = []) {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params })
      return { rows }
    },
  }
}

function appWith(db: ReturnType<typeof fakeDb>) {
  const app = express()
  app.use(express.json())
  app.use(createRealEstateRouter(db))
  return app
}

const row = (id: string) => ({
  id,
  title: 'Condo',
  primary_photo_url: null,
  stored_photo_urls: null,
  listed_at: null,
  first_seen_at: '2026-09-01T00:00:00.000Z',
  listed_price: '13',
  listing_type: 'sale',
  property_type: 'condo',
  price_php: '13000000',
  price_basis: 'total',
  lot_sqm: null,
  floor_sqm: '35',
  bedrooms: 1,
  bathrooms: 1,
  project_name: 'Portico',
  area_text: 'Pasig',
  tags: [],
  confidence: 'high',
  price_per_sqm: '371428.5714',
})

test('GET /real-estate returns the mapped listings and no next page when the page is short', async () => {
  const db = fakeDb([row('a')])

  const res = await request(appWith(db)).get('/real-estate')

  expect(res.status).toBe(200)
  expect(res.body.nextPage).toBeNull()
  expect(res.body.listings).toHaveLength(1)
  expect(res.body.listings[0]).toMatchObject({ id: 'a', price_php: 13000000, price_per_sqm: 371428.5714 })
})

test('GET /real-estate binds the filters as query params and pages with limit and offset', async () => {
  const db = fakeDb()

  await request(appWith(db)).get('/real-estate').query({ kind: 'sale', type: 'condo', area: 'Pasig', page: '2' })

  expect(db.calls).toHaveLength(1)
  const { sql, params } = db.calls[0]
  expect(sql).toContain('x.listing_type = $1')
  expect(sql).toContain('x.property_type = $2')
  expect(sql).toContain('x.area_text ILIKE $3')
  expect(params).toEqual(['sale', 'condo', '%Pasig%', REAL_ESTATE_PAGE_SIZE, REAL_ESTATE_PAGE_SIZE])
})

test('GET /real-estate points at the next page when a full page came back', async () => {
  const rows = Array.from({ length: REAL_ESTATE_PAGE_SIZE }, (_, i) => row(String(i)))

  const res = await request(appWith(fakeDb(rows)))
    .get('/real-estate')
    .query({ page: '4' })

  expect(res.body.nextPage).toBe(5)
})

test('GET /real-estate answers 400 with the issues and queries nothing for a repeated param', async () => {
  const db = fakeDb()

  const res = await request(appWith(db)).get('/real-estate?kind=sale&kind=rent')

  expect(res.status).toBe(400)
  expect(typeof res.body.error).toBe('string')
  expect(Array.isArray(res.body.issues)).toBe(true)
  expect(db.calls).toHaveLength(0)
})
