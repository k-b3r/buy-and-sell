import express from 'express'
import request from 'supertest'
import type { ListingPhotos } from '../src/modules/collection'
import type { QueryClient } from '../src/platform/storage'
import { createApp } from './app'
import { createJobStore } from './jobState'
import { createRefreshHandlers, createRefreshRouter } from './refreshHandlers'
import type { RefreshHandlers } from './refreshHandlers'
import { createRefreshJobStatusHandler } from './routes/refreshJob'
import { createCancelRefreshJobHandler } from './routes/refreshJobCancel'
import type { RouteHandler } from './routes/result'

const noopLogger = { info() {}, warn() {}, error() {} }

// Answers 500, so a route wired to the wrong handler fails loudly instead of
// quietly passing the test.
const unmounted: RouteHandler = async () => ({ statusCode: 500, body: {} })

function fakeHandlers(overrides: Partial<RefreshHandlers> = {}): RefreshHandlers {
  return { refresh: unmounted, refreshProduct: unmounted, jobStatus: unmounted, cancelJob: unmounted, ...overrides }
}

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

function routerApp(handlers: RefreshHandlers) {
  const app = express()
  app.use(express.json())
  app.use(createRefreshRouter(handlers))
  return app
}

test('POST /refresh runs the single-listing handler with the parsed body and relays its result', async () => {
  const seen: unknown[] = []
  const app = routerApp(
    fakeHandlers({
      refresh: async (body) => {
        seen.push(body)
        return { statusCode: 200, body: { status: 'alive' } }
      },
    }),
  )

  const res = await request(app).post('/refresh').send({ id: '123' })

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ status: 'alive' })
  expect(seen).toEqual([{ id: '123' }])
})

test('POST /refresh answers the handler 400 when the body has no id', async () => {
  const real = handlers()
  const app = routerApp(fakeHandlers({ refresh: real.refresh }))

  const res = await request(app).post('/refresh').send({})

  expect(res.status).toBe(400)
  expect(res.body).toEqual({ error: 'missing or invalid "id"' })
})

test('POST /refresh-product runs the bulk handler with the parsed body and relays its result', async () => {
  const seen: unknown[] = []
  const app = routerApp(
    fakeHandlers({
      refreshProduct: async (body) => {
        seen.push(body)
        return { statusCode: 429, body: { error: 'a refresh is already in progress, try again shortly' } }
      },
    }),
  )

  const res = await request(app).post('/refresh-product').send({ productId: 42 })

  expect(res.status).toBe(429)
  expect(res.body).toEqual({ error: 'a refresh is already in progress, try again shortly' })
  expect(seen).toEqual([{ productId: 42 }])
})

test('POST /listings/:id/refresh runs the single-listing handler with the path id', async () => {
  const seen: unknown[] = []
  const app = routerApp(
    fakeHandlers({
      refresh: async (body) => {
        seen.push(body)
        return { statusCode: 200, body: { status: 'alive' } }
      },
    }),
  )

  const res = await request(app).post('/listings/123/refresh')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ status: 'alive' })
  expect(seen).toEqual([{ id: '123' }])
})

test('POST /products/:id/refresh starts the bulk handler with the numeric path id and relays its status', async () => {
  const seen: unknown[] = []
  const app = routerApp(
    fakeHandlers({
      refreshProduct: async (body) => {
        seen.push(body)
        return { statusCode: 429, body: { error: 'a refresh is already in progress, try again shortly' } }
      },
    }),
  )

  const res = await request(app).post('/products/42/refresh')

  expect(res.status).toBe(429)
  expect(res.body).toEqual({ error: 'a refresh is already in progress, try again shortly' })
  expect(seen).toEqual([{ productId: 42 }])
})

test('POST /products/:id/refresh with a non-numeric id answers the handler 400 for a missing productId', async () => {
  const real = handlers()
  const app = routerApp(fakeHandlers({ refreshProduct: real.refreshProduct }))

  const res = await request(app).post('/products/abc/refresh')

  expect(res.status).toBe(400)
  expect(res.body).toEqual({ error: 'missing or invalid "productId"' })
})

test('GET /refresh-job reports the job status handler result', async () => {
  const jobs = createJobStore()
  jobs.start(5, 10)
  const app = routerApp(fakeHandlers({ jobStatus: createRefreshJobStatusHandler(jobs) }))

  const res = await request(app).get('/refresh-job')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ productId: 5, total: 10, completed: 0, status: 'running' })
})

test('POST /refresh-job/cancel reaches the cancel handler', async () => {
  const jobs = createJobStore()
  jobs.start(5, 10)
  const app = routerApp(fakeHandlers({ cancelJob: createCancelRefreshJobHandler(jobs) }))

  const res = await request(app).post('/refresh-job/cancel')

  expect(res.status).toBe(200)
  expect(jobs.isCancelRequested()).toBe(true)
})

test('POST /refresh-job/cancel relays the handler 400 when no job is running', async () => {
  const app = routerApp(fakeHandlers({ cancelJob: createCancelRefreshJobHandler(createJobStore()) }))

  const res = await request(app).post('/refresh-job/cancel')

  expect(res.status).toBe(400)
  expect(res.body).toEqual({ error: 'no refresh job in progress' })
})

const API_KEY = 'test-key'

function authedApp(handlers: RefreshHandlers, log: (msg: string) => void = () => {}) {
  return createApp({ apiKey: API_KEY, log, routers: [createRefreshRouter(handlers)] })
}

test('a handler that throws behind a refresh route answers an opaque JSON 500 and logs the detail', async () => {
  const logged: string[] = []
  const app = authedApp(
    fakeHandlers({
      refresh: async () => {
        throw new Error('relation "listings" does not exist')
      },
      refreshProduct: async () => {
        throw new Error('browser crashed')
      },
    }),
    (msg) => logged.push(msg),
  )

  const responses = [
    await request(app).post('/refresh').set('authorization', `Bearer ${API_KEY}`).send({ id: '1' }),
    await request(app).post('/refresh-product').set('authorization', `Bearer ${API_KEY}`).send({ productId: 2 }),
    await request(app).post('/listings/1/refresh').set('authorization', `Bearer ${API_KEY}`),
    await request(app).post('/products/2/refresh').set('authorization', `Bearer ${API_KEY}`),
  ]

  for (const res of responses) {
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'internal error' })
  }
  expect(logged).toHaveLength(4)
  expect(logged[0]).toContain('relation "listings" does not exist')
  expect(logged[1]).toContain('browser crashed')
})

test('the refresh routes answer 401 without the bearer key and run the handler with it', async () => {
  const seen: unknown[] = []
  const app = authedApp(
    fakeHandlers({
      refresh: async (body) => {
        seen.push(body)
        return { statusCode: 200, body: { status: 'alive' } }
      },
      refreshProduct: async (body) => {
        seen.push(body)
        return { statusCode: 200, body: { productId: 2, total: 3 } }
      },
    }),
  )

  const noKeyListing = await request(app).post('/listings/1/refresh')
  const noKeyProduct = await request(app).post('/products/2/refresh').set('authorization', 'Bearer wrong-key')
  expect(noKeyListing.status).toBe(401)
  expect(noKeyProduct.status).toBe(401)
  expect(seen).toEqual([])

  const bodyRefresh = await request(app).post('/refresh').set('authorization', `Bearer ${API_KEY}`).send({ id: '1' })
  const listing = await request(app).post('/listings/1/refresh').set('authorization', `Bearer ${API_KEY}`)
  const product = await request(app).post('/products/2/refresh').set('authorization', `Bearer ${API_KEY}`)
  expect(bodyRefresh.body).toEqual({ status: 'alive' })
  expect(listing.body).toEqual({ status: 'alive' })
  expect(product.body).toEqual({ productId: 2, total: 3 })
  expect(seen).toEqual([{ id: '1' }, { id: '1' }, { productId: 2 }])
})
