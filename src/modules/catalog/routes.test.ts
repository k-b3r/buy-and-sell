import express from 'express'
import request from 'supertest'
import { createCatalogRouter } from './routes'
import type { RouteCache } from './routes'

type Call = { sql: string; params: unknown[] }

function fakeDb(rowsFor: (sql: string) => unknown[] = () => []) {
  const calls: Call[] = []
  return {
    calls,
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params })
      return { rows: rowsFor(sql) }
    },
  }
}

// Records wraps and invalidations; never serves from memory, so every request
// reaches the db and the test sees the exact key and tags the route chose.
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
  app.use(createCatalogRouter(db, cache))
  return app
}

const PRODUCT_ROW = { id: 7, base_model: 'iPhone 13', variant_tier: null, price_lookup_excluded: false }
const LISTING_ROWS = [
  { id: 'a', title: 'A', price_amount: '100', sold_at: null, is_peer: true, is_saved: false },
  { id: 'b', title: 'B', price_amount: '200', sold_at: null, is_peer: true, is_saved: true },
]

function detailRows(sql: string): unknown[] {
  if (sql.includes('FROM products p')) return [PRODUCT_ROW]
  if (sql.includes('FROM listings l')) return LISTING_ROWS
  return []
}

test('GET /products returns the page of summaries and null nextOffset when under a full page', async () => {
  const db = fakeDb(() => [{ id: 1, base_model: 'iPhone 13', listing_count: '3' }])
  const { cache, wraps } = fakeCache()

  const res = await request(appWith(db, cache)).get('/products')

  expect(res.status).toBe(200)
  expect(res.body.nextOffset).toBeNull()
  expect(res.body.products).toHaveLength(1)
  expect(res.body.products[0]).toMatchObject({ id: 1, base_model: 'iPhone 13', listing_count: 3 })
  expect(wraps[0].tags).toEqual(['products-list'])
})

test('GET /products passes search, filters and paging to the query as bound params', async () => {
  const db = fakeDb()

  await request(appWith(db))
    .get('/products')
    .query({ q: 'iphone', category: ['Phones', 'Laptops'], subCategory: 'Mac', offset: '30' })

  expect(db.calls).toHaveLength(1)
  expect(db.calls[0].params).toEqual(['%iphone%', ['Phones', 'Laptops'], ['Mac'], 30, 30])
})

test('GET /products sets nextOffset to the next page start when a full page came back', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, base_model: `m${i}`, listing_count: '1' }))
  const db = fakeDb(() => rows)

  const res = await request(appWith(db)).get('/products').query({ offset: '60' })

  expect(res.body.nextOffset).toBe(90)
})

test('GET /products keys the cache on the filters regardless of selection order', async () => {
  const db = fakeDb()
  const { cache, wraps } = fakeCache()
  const app = appWith(db, cache)

  await request(app).get('/products?category=B&category=A')
  await request(app).get('/products?category=A&category=B')

  expect(wraps[0].key).toBe(wraps[1].key)
})

test('GET /products answers 400 for a bad offset and runs no query', async () => {
  const db = fakeDb()

  const res = await request(appWith(db)).get('/products').query({ offset: 'abc' })

  expect(res.status).toBe(400)
  expect(res.body.error).toBeDefined()
  expect(db.calls).toHaveLength(0)
})

test('GET /products/:id returns the product detail with its listings', async () => {
  const db = fakeDb(detailRows)
  const { cache, wraps } = fakeCache()

  const res = await request(appWith(db, cache)).get('/products/7')

  expect(res.status).toBe(200)
  expect(res.body.product.id).toBe(7)
  expect(res.body.product.listings.map((l: { id: string }) => l.id).sort()).toEqual(['a', 'b'])
  expect(wraps[0]).toEqual({ key: 'product-detail:7', tags: ['product:7'] })
  expect(db.calls.every((c) => c.params[0] === 7)).toBe(true)
})

test('GET /products/:id answers { product: null } for an unknown product', async () => {
  const res = await request(appWith(fakeDb())).get('/products/999')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ product: null })
})

test('GET /products/:id answers 400 for a non-numeric id', async () => {
  const db = fakeDb()

  const res = await request(appWith(db)).get('/products/abc')

  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0)
})

test('GET /products/:id/listings returns one filtered page from the cached product detail', async () => {
  const db = fakeDb(detailRows)
  const { cache, wraps } = fakeCache()

  const res = await request(appWith(db, cache)).get('/products/7/listings?hideSold=0&sort=price_desc')

  expect(res.status).toBe(200)
  expect(res.body.nextOffset).toBeNull()
  expect(res.body.matchedCount).toBe(2)
  expect(res.body.allIds).toEqual(['b', 'a'])
  expect(res.body.listings.map((l: { id: string }) => l.id)).toEqual(['b', 'a'])
  expect(wraps[0]).toEqual({ key: 'product-detail:7', tags: ['product:7'] })
})

test('GET /products/:id/listings answers 404 with an empty page for an unknown product', async () => {
  const res = await request(appWith(fakeDb())).get('/products/999/listings')

  expect(res.status).toBe(404)
  expect(res.body).toEqual({ listings: [], nextOffset: null, matchedCount: 0, allIds: [] })
})

test('GET /products/:id/listings answers 400 for a bad offset', async () => {
  const res = await request(appWith(fakeDb(detailRows))).get('/products/7/listings?offset=-1')

  expect(res.status).toBe(400)
})

test('GET /categories/tree returns the sub-category tree under the categories tag', async () => {
  const db = fakeDb(() => [{ sub_category: 'Smartphones', parent_category: 'Phones' }])
  const { cache, wraps } = fakeCache()

  const res = await request(appWith(db, cache)).get('/categories/tree')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({
    tree: [{ subCategory: 'Smartphones', parentCategory: 'Phones' }],
  })
  expect(wraps[0].tags).toEqual(['categories'])
})

test('GET /categories/sold-counts returns weekly sold counts under the sold-listings tag', async () => {
  const db = fakeDb(() => [])
  const { cache, wraps } = fakeCache()

  const res = await request(appWith(db, cache)).get('/categories/sold-counts')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ categories: [] })
  expect(wraps[0].tags).toEqual(['sold-listings'])
})

test('GET /review-queue returns the products needing review under the needs-review tag', async () => {
  const db = fakeDb(() => [{ id: 3, base_model: 'Mystery Box', price_history: null }])
  const { cache, wraps } = fakeCache()

  const res = await request(appWith(db, cache)).get('/review-queue')

  expect(res.status).toBe(200)
  expect(res.body.products).toHaveLength(1)
  expect(res.body.products[0]).toMatchObject({ id: 3, base_model: 'Mystery Box' })
  expect(db.calls[0].sql).toContain("price_lookup_review_status = 'needs_review'")
  expect(wraps[0].tags).toEqual(['needs-review'])
})

test('POST /products/:id/mark-reviewed clears the review status and drops the stale caches', async () => {
  const db = fakeDb()
  const { cache, invalidated } = fakeCache()

  const res = await request(appWith(db, cache)).post('/products/7/mark-reviewed')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true })
  expect(db.calls).toHaveLength(1)
  expect(db.calls[0].sql).toContain('price_lookup_review_status = NULL')
  expect(db.calls[0].params).toEqual([7])
  expect(invalidated).toEqual([['needs-review', 'product:7']])
})

test('POST /products/:id/mark-reviewed answers 400 for a bad id and writes nothing', async () => {
  const db = fakeDb()
  const { cache, invalidated } = fakeCache()

  const res = await request(appWith(db, cache)).post('/products/0/mark-reviewed')

  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0)
  expect(invalidated).toEqual([])
})
