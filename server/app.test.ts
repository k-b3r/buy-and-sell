import express from 'express'
import request from 'supertest'
import { createApp } from './app'
import { createRateLimiter } from './rateLimiter'
import type { RateLimiter } from './rateLimiter'

const API_KEY = 'test-secret'
const AUTH = `Bearer ${API_KEY}`

function freshLimiter() {
  return createRateLimiter(10, 5 * 60 * 1000)
}

// A router shaped like every feature router: one POST path that hands the
// parsed body to a handler and answers with what it returns.
function refreshRouter(handler: (body: unknown) => Promise<{ statusCode: number; body: unknown }>) {
  const router = express.Router()
  router.post('/refresh', async (req, res) => {
    const result = await handler(req.body)
    res.status(result.statusCode).json(result.body)
  })
  return router
}

const ok = async () => ({ statusCode: 200, body: { ok: true } })

function app(
  routers: express.Router[],
  rateLimiter: RateLimiter = freshLimiter(),
  log: (msg: string) => void = () => {},
) {
  return createApp({ apiKey: API_KEY, routers, rateLimiter, log })
}

test('mounts a router that receives the parsed body and relays its status and body', async () => {
  let receivedBody: unknown
  const server = app([
    refreshRouter(async (body) => {
      receivedBody = body
      return { statusCode: 200, body: { ok: true } }
    }),
  ])

  const res = await request(server).post('/refresh').set('authorization', AUTH).send({ id: '123' })

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true })
  expect(receivedBody).toEqual({ id: '123' })
})

test('404s for a path no router mounts, and for a method no router handles', async () => {
  const server = app([refreshRouter(ok)])

  const wrongMethod = await request(server).get('/refresh').set('authorization', AUTH)
  const wrongPath = await request(server).post('/nope').set('authorization', AUTH)

  expect(wrongMethod.status).toBe(404)
  expect(wrongMethod.body).toEqual({ error: 'not found' })
  expect(wrongPath.status).toBe(404)
})

test('auth runs before routing, so an unauthenticated request learns nothing about which paths exist', async () => {
  const server = app([refreshRouter(ok)])

  const unknown = await request(server).post('/nope')
  const known = await request(server).post('/refresh')

  expect(unknown.status).toBe(401)
  expect(unknown.body).toEqual({ error: 'unauthorized' })
  expect(known.status).toBe(401)
})

test('rejects a wrong bearer token for a route that exists', async () => {
  const server = app([refreshRouter(ok)])

  const res = await request(server).post('/refresh').set('authorization', 'Bearer wrong')

  expect(res.status).toBe(401)
  expect(res.body).toEqual({ error: 'unauthorized' })
})

test('400s on an invalid JSON body for an authenticated request', async () => {
  const server = app([refreshRouter(ok)])

  const res = await request(server)
    .post('/refresh')
    .set('authorization', AUTH)
    .set('content-type', 'application/json')
    .send('not json')

  expect(res.status).toBe(400)
  expect(res.body).toEqual({ error: 'invalid JSON body' })
})

test('parses a JSON body even without a JSON content type, as the old server did', async () => {
  let receivedBody: unknown
  const server = app([
    refreshRouter(async (body) => {
      receivedBody = body
      return { statusCode: 200, body: {} }
    }),
  ])

  await request(server)
    .post('/refresh')
    .set('authorization', AUTH)
    .set('content-type', 'text/plain')
    .send('{"worker":"collect"}')

  expect(receivedBody).toEqual({ worker: 'collect' })
})

test('treats an empty body as {}', async () => {
  let receivedBody: unknown
  const server = app([
    refreshRouter(async (body) => {
      receivedBody = body
      return { statusCode: 200, body: {} }
    }),
  ])

  await request(server).post('/refresh').set('authorization', AUTH)

  expect(receivedBody).toEqual({})
})

test('mounts two routers independently and puts both behind the same auth', async () => {
  const other = express.Router()
  other.get('/other-thing', (_req, res) => {
    res.json({ from: 'other-thing' })
  })
  const server = app([refreshRouter(ok), other])

  const authed = await request(server).get('/other-thing').set('authorization', AUTH)
  const unauthed = await request(server).get('/other-thing').set('authorization', 'Bearer wrong')

  expect(authed.body).toEqual({ from: 'other-thing' })
  expect(unauthed.status).toBe(401)
})

test('a router path param reaches the handler behind the same auth', async () => {
  const router = express.Router()
  router.get('/things/:id', (req, res) => {
    res.json({ id: req.params.id })
  })
  const server = app([router])

  const authed = await request(server).get('/things/7').set('authorization', AUTH)
  const unauthed = await request(server).get('/things/7')

  expect(authed.body).toEqual({ id: '7' })
  expect(unauthed.status).toBe(401)
})

test('an IP gets 429 after repeated auth failures, even with the correct token', async () => {
  const server = app([refreshRouter(ok)], createRateLimiter(3, 5 * 60 * 1000))

  for (let i = 0; i < 3; i++) await request(server).post('/refresh').set('authorization', 'Bearer wrong')
  const res = await request(server).post('/refresh').set('authorization', AUTH)

  expect(res.status).toBe(429)
  expect(res.body).toEqual({ error: 'too many failed attempts, try again later' })
})

test('rate limiting is per client IP - one IP failing does not block another', async () => {
  const server = app([refreshRouter(ok)], createRateLimiter(2, 5 * 60 * 1000))

  for (let i = 0; i < 2; i++) {
    await request(server).post('/refresh').set('authorization', 'Bearer wrong').set('x-forwarded-for', '1.1.1.1')
  }
  const otherIp = await request(server).post('/refresh').set('authorization', AUTH).set('x-forwarded-for', '2.2.2.2')
  const blockedIp = await request(server).post('/refresh').set('authorization', AUTH).set('x-forwarded-for', '1.1.1.1')

  expect(otherIp.status).toBe(200)
  expect(blockedIp.status).toBe(429)
})

test('a successful request clears prior failures, so the IP is not left blocked', async () => {
  const server = app([refreshRouter(ok)], createRateLimiter(2, 5 * 60 * 1000))

  await request(server).post('/refresh').set('authorization', 'Bearer wrong')
  await request(server).post('/refresh').set('authorization', AUTH)
  await request(server).post('/refresh').set('authorization', 'Bearer wrong')
  const res = await request(server).post('/refresh').set('authorization', AUTH)

  expect(res.status).toBe(200)
})

test('a handler that throws becomes a 500 with no detail, and the error is logged', async () => {
  const logged: string[] = []
  const server = app(
    [
      refreshRouter(async () => {
        throw new Error('relation "listings" does not exist')
      }),
    ],
    freshLimiter(),
    (msg) => logged.push(msg),
  )

  const res = await request(server).post('/refresh').set('authorization', AUTH)

  expect(res.status).toBe(500)
  expect(res.body).toEqual({ error: 'internal error' })
  expect(logged.join('\n')).toContain('POST /refresh failed')
  expect(logged.join('\n')).toContain('relation "listings" does not exist')
})

test('413s a body over the size limit', async () => {
  const server = app([refreshRouter(ok)])

  const res = await request(server)
    .post('/refresh')
    .set('authorization', AUTH)
    .set('content-type', 'application/json')
    .send(JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) }))

  expect(res.status).toBe(413)
})
