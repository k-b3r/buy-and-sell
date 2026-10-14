import express from 'express'
import request from 'supertest'
import { createCollectionRouter } from './routes'

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

function appWith(db: ReturnType<typeof fakeDb>) {
  const app = express()
  app.use(express.json())
  app.use(createCollectionRouter(db))
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
