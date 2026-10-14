import express from 'express'
import request from 'supertest'
import { createPricingRouter } from './routes'

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

function fakeCache() {
  const invalidated: string[][] = []
  return {
    invalidated,
    invalidate: (...tags: string[]) => {
      invalidated.push(tags)
    },
  }
}

function appWith(db: ReturnType<typeof fakeDb>, cache = fakeCache()) {
  const app = express()
  app.use(express.json())
  app.use(createPricingRouter(db, cache))
  return app
}

const exclusionsUiOn = (sql: string) =>
  sql.includes('FROM settings') ? [{ key: 'pricing.exclusions_ui_enabled', value: '1', updated_at: null }] : []

// deals

test('GET /deals returns the page of deals with the settings floors applied and null nextOffset', async () => {
  const db = fakeDb((sql) =>
    sql.includes('FROM settings')
      ? [
          { key: 'discount_policy.min_profit_pesos', value: '2500', updated_at: null },
          { key: 'discount_policy.min_price_pesos', value: '800', updated_at: null },
        ]
      : [{ listing_id: 'a', title: 'A', ask_price: '100' }],
  )

  const res = await request(appWith(db)).get('/deals')

  expect(res.status).toBe(200)
  expect(res.body.nextOffset).toBeNull()
  expect(res.body.deals).toHaveLength(1)
  const dealsCall = db.calls.find((c) => !c.sql.includes('FROM settings'))
  expect(dealsCall?.params.slice(0, 2)).toEqual([2500, 800])
})

test('GET /deals falls back to the default floors when the settings are missing', async () => {
  const db = fakeDb()

  await request(appWith(db)).get('/deals')

  const dealsCall = db.calls.find((c) => !c.sql.includes('FROM settings'))
  expect(dealsCall?.params.slice(0, 2)).toEqual([1000, 500])
})

test('GET /deals passes filters and paging through and reports the next offset on a full page', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ listing_id: String(i), title: 'x', ask_price: '1' }))
  const db = fakeDb((sql) => (sql.includes('FROM settings') ? [] : rows))

  const res = await request(appWith(db))
    .get('/deals')
    .query({ category: ['Phones'], minTier: 'sold_comps', soldOnly: 'true', lowConfidence: 'true', offset: '30' })

  expect(res.status).toBe(200)
  expect(res.body.nextOffset).toBe(60)
  const dealsCall = db.calls.find((c) => !c.sql.includes('FROM settings'))
  expect(dealsCall?.params).toContainEqual(['Phones'])
  expect(dealsCall?.params).toContain(3)
  // limit, offset, then the per-category cap
  expect(dealsCall?.params.slice(-3, -1)).toEqual([30, 30])
})

test('GET /deals answers 400 for a malformed number and runs no deals query', async () => {
  const db = fakeDb()

  const res = await request(appWith(db)).get('/deals').query({ minProfit: 'abc' })

  expect(res.status).toBe(400)
  expect(res.body.error).toBe('minProfit must be a number')
  expect(db.calls).toHaveLength(0)
})

// notifications

test('GET /notifications returns the latest notifications with the unread count', async () => {
  const db = fakeDb((sql) =>
    sql.includes('count(*)')
      ? [{ count: '3' }]
      : [
          {
            id: '9',
            listing_id: 'l1',
            product_id: '4',
            title: 'T',
            discount_percent: '30',
            reference_price: '1000',
            created_at: '2026-10-14T00:00:00Z',
          },
        ],
  )

  const res = await request(appWith(db)).get('/notifications')

  expect(res.status).toBe(200)
  expect(res.body.unreadCount).toBe(3)
  expect(res.body.notifications).toHaveLength(1)
  expect(res.body.notifications[0]).toMatchObject({ id: 9, listing_id: 'l1', product_id: 4 })
})

test('POST /notifications/:id/read marks that notification read', async () => {
  const db = fakeDb()

  const res = await request(appWith(db)).post('/notifications/15/read')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true })
  expect(db.calls[0].sql).toContain('UPDATE discount_notifications SET read_at = now()')
  expect(db.calls[0].params).toEqual([15])
})

test('POST /notifications/:id/read answers 400 for a bad id and writes nothing', async () => {
  const db = fakeDb()

  const res = await request(appWith(db)).post('/notifications/abc/read')

  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0)
})

test('POST /notifications/mark-all-read marks every unread notification read', async () => {
  const db = fakeDb()

  const res = await request(appWith(db)).post('/notifications/mark-all-read')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true })
  expect(db.calls[0].sql).toContain('WHERE read_at IS NULL')
})

// exclusions

test('GET /price-exclusions/summary returns the reason groups', async () => {
  const db = fakeDb(() => [{ reason: 'groq_generic', count: 4, retry: false }])

  const res = await request(appWith(db)).get('/price-exclusions/summary')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ summary: [{ reason: 'groq_generic', count: 4, retry: false }] })
})

test('GET /price-exclusions returns one reason page with offset and limit as bound params', async () => {
  const db = fakeDb(() => [{ id: 1, base_model: 'Box', variant_tier: null, listing_count: 2 }])

  const res = await request(appWith(db))
    .get('/price-exclusions')
    .query({ reason: 'groq_generic', offset: '50', limit: '50' })

  expect(res.status).toBe(200)
  expect(res.body.products).toHaveLength(1)
  expect(db.calls[0].params).toEqual(['groq_generic', 50, 50])
})

test('GET /price-exclusions answers 400 without a reason', async () => {
  const db = fakeDb()

  const res = await request(appWith(db)).get('/price-exclusions')

  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0)
})

test('POST /products/:id/exclude excludes with manual_review and drops the product, list and review caches', async () => {
  const db = fakeDb()
  const cache = fakeCache()

  const res = await request(appWith(db, cache)).post('/products/7/exclude')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true })
  expect(db.calls[0]).toEqual({ sql: 'DELETE FROM price_exclusion_overrides WHERE product_id = $1', params: [7] })
  expect(db.calls[1].params).toEqual(['manual_review', 7])
  expect(cache.invalidated).toEqual([['needs-review', 'products-list', 'product:7']])
})

test('POST /products/:id/exclude answers 400 for a bad id and changes nothing', async () => {
  const db = fakeDb()
  const cache = fakeCache()

  const res = await request(appWith(db, cache)).post('/products/0/exclude')

  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0)
  expect(cache.invalidated).toEqual([])
})

test('POST /products/:id/include includes the product and drops the list and product caches', async () => {
  const db = fakeDb(exclusionsUiOn)
  const cache = fakeCache()

  const res = await request(appWith(db, cache)).post('/products/7/include')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true })
  const write = db.calls.find((c) => c.sql.includes('price_exclusion_overrides'))
  expect(write?.params[0]).toBe(7)
  expect(cache.invalidated).toEqual([['products-list', 'product:7']])
})

test('POST /products/:id/include answers 404 disabled and writes nothing while the exclusions UI is off', async () => {
  const db = fakeDb()
  const cache = fakeCache()

  const res = await request(appWith(db, cache)).post('/products/7/include')

  expect(res.status).toBe(404)
  expect(res.body).toEqual({ error: 'disabled' })
  expect(db.calls.every((c) => c.sql.includes('FROM settings'))).toBe(true)
  expect(cache.invalidated).toEqual([])
})

test('POST /products/:id/include answers 400 invalid product id for a bad id', async () => {
  const db = fakeDb(exclusionsUiOn)

  const res = await request(appWith(db)).post('/products/abc/include')

  expect(res.status).toBe(400)
})

// manual price

test('POST /products/:id/manual-price records the price, clears the review flag and drops the caches', async () => {
  const db = fakeDb()
  const cache = fakeCache()

  const res = await request(appWith(db, cache))
    .post('/products/7/manual-price')
    .send({ kind: 'new', priceLow: 1500, priceHigh: 2000 })

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true })
  expect(db.calls).toHaveLength(2)
  expect(db.calls[0].sql).toContain('INSERT INTO product_price_history')
  expect(db.calls[0].params).toEqual([7, 1500, 2000, 'manual_new_retail'])
  expect(db.calls[1].sql).toContain('price_lookup_review_status = NULL')
  expect(db.calls[1].params).toEqual([7])
  expect(cache.invalidated).toEqual([['needs-review', 'products-list', 'product:7']])
})

test.each([
  [{ kind: 'used', priceLow: 1, priceHigh: 2 }, 'kind must be "new" or "secondhand"'],
  [{ kind: 'new', priceLow: '1', priceHigh: 2 }, 'priceLow/priceHigh must be numbers'],
  [{ kind: 'new', priceLow: 5, priceHigh: 2 }, 'priceLow must be positive and not greater than priceHigh'],
])('POST /products/:id/manual-price answers 400 for %j and writes nothing', async (body, message) => {
  const db = fakeDb()
  const cache = fakeCache()

  const res = await request(appWith(db, cache)).post('/products/7/manual-price').send(body)

  expect(res.status).toBe(400)
  expect(res.body.error).toBe(message)
  expect(db.calls).toHaveLength(0)
  expect(cache.invalidated).toEqual([])
})

test('POST /products/:id/manual-price answers 400 for a bad id', async () => {
  const db = fakeDb()

  const res = await request(appWith(db))
    .post('/products/abc/manual-price')
    .send({ kind: 'new', priceLow: 1, priceHigh: 2 })

  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0)
})
