import express from 'express'
import request from 'supertest'
import type { ListingPhotos } from '../src/modules/collection'
import type { QueryClient } from '../src/platform/storage'
import { createApp } from './app'
import { createRefreshHandlers, createRefreshRouter } from './refreshHandlers'

const noopLogger = { info() {}, warn() {}, error() {} }

function handlers() {
  return createRefreshHandlers({
    db: {} as QueryClient,
    photos: {} as ListingPhotos,
    logger: noopLogger,
    env: {},
    cache: { invalidate() {} },
  })
}

test('createRefreshHandlers returns the single-listing, product, job status and job cancel handlers', () => {
  expect(Object.keys(handlers()).sort()).toEqual(['cancelJob', 'jobStatus', 'refresh', 'refreshProduct'])
})

test('the job status handler reports no job before one has started', async () => {
  const result = await handlers().jobStatus(undefined)
  expect(result).toEqual({ statusCode: 200, body: null })
})

function routerApp(handlers: Parameters<typeof createRefreshRouter>[0]) {
  const app = express()
  app.use(express.json())
  app.use(createRefreshRouter(handlers))
  return app
}

test('POST /listings/:id/refresh runs the single-listing handler with the path id', async () => {
  const seen: unknown[] = []
  const app = routerApp({
    refresh: async (body) => {
      seen.push(body)
      return { statusCode: 200, body: { status: 'alive' } }
    },
    refreshProduct: async () => ({ statusCode: 500, body: {} }),
  })

  const res = await request(app).post('/listings/123/refresh')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ status: 'alive' })
  expect(seen).toEqual([{ id: '123' }])
})

test('POST /products/:id/refresh starts the bulk handler with the numeric path id and relays its status', async () => {
  const seen: unknown[] = []
  const app = routerApp({
    refresh: async () => ({ statusCode: 500, body: {} }),
    refreshProduct: async (body) => {
      seen.push(body)
      return { statusCode: 429, body: { error: 'a refresh is already in progress, try again shortly' } }
    },
  })

  const res = await request(app).post('/products/42/refresh')

  expect(res.status).toBe(429)
  expect(res.body).toEqual({ error: 'a refresh is already in progress, try again shortly' })
  expect(seen).toEqual([{ productId: 42 }])
})

test('POST /products/:id/refresh with a non-numeric id answers the handler 400 for a missing productId', async () => {
  const real = handlers()
  const app = routerApp({ refresh: real.refresh, refreshProduct: real.refreshProduct })

  const res = await request(app).post('/products/abc/refresh')

  expect(res.status).toBe(400)
  expect(res.body).toEqual({ error: 'missing or invalid "productId"' })
})

const API_KEY = 'test-key'

function authedApp(handlers: Parameters<typeof createRefreshRouter>[0], log: (msg: string) => void = () => {}) {
  return createApp({ apiKey: API_KEY, log, routers: [createRefreshRouter(handlers)] })
}

test('a handler that throws behind the id-path routes answers an opaque JSON 500 and logs the detail', async () => {
  const logged: string[] = []
  const app = authedApp(
    {
      refresh: async () => {
        throw new Error('relation "listings" does not exist')
      },
      refreshProduct: async () => {
        throw new Error('browser crashed')
      },
    },
    (msg) => logged.push(msg),
  )

  const listing = await request(app).post('/listings/1/refresh').set('authorization', `Bearer ${API_KEY}`)
  const product = await request(app).post('/products/2/refresh').set('authorization', `Bearer ${API_KEY}`)

  for (const res of [listing, product]) {
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'internal error' })
  }
  expect(logged).toHaveLength(2)
  expect(logged[0]).toContain('relation "listings" does not exist')
  expect(logged[1]).toContain('browser crashed')
})

test('the id-path refresh routes answer 401 without the bearer key and run the handler with it', async () => {
  const seen: unknown[] = []
  const app = authedApp({
    refresh: async (body) => {
      seen.push(body)
      return { statusCode: 200, body: { status: 'alive' } }
    },
    refreshProduct: async (body) => {
      seen.push(body)
      return { statusCode: 200, body: { productId: 2, total: 3 } }
    },
  })

  const noKeyListing = await request(app).post('/listings/1/refresh')
  const noKeyProduct = await request(app).post('/products/2/refresh').set('authorization', 'Bearer wrong-key')
  expect(noKeyListing.status).toBe(401)
  expect(noKeyProduct.status).toBe(401)
  expect(seen).toEqual([])

  const listing = await request(app).post('/listings/1/refresh').set('authorization', `Bearer ${API_KEY}`)
  const product = await request(app).post('/products/2/refresh').set('authorization', `Bearer ${API_KEY}`)
  expect(listing.body).toEqual({ status: 'alive' })
  expect(product.body).toEqual({ productId: 2, total: 3 })
  expect(seen).toEqual([{ id: '1' }, { productId: 2 }])
})
