import request from 'supertest'
import { createApp } from '../app'
import { createSettingsRouter } from './settings'

const AUTH = 'Bearer test-secret'

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
  return createApp({ apiKey: 'test-secret', log: () => {}, routers: [createSettingsRouter(db)] })
}

test('GET /settings returns every setting with its numeric value', async () => {
  const db = fakeDb([{ key: 'collect.max_items_default', value: '50', updated_at: '2026-10-13T00:00:00Z' }])

  const res = await request(appWith(db)).get('/settings').set('authorization', AUTH)

  expect(res.status).toBe(200)
  expect(res.body).toEqual({
    settings: [{ key: 'collect.max_items_default', value: 50, updatedAt: '2026-10-13T00:00:00Z' }],
  })
})

test('PATCH /settings writes the updates in one batched UPDATE and answers ok', async () => {
  const db = fakeDb()
  const updates = [
    { key: 'collect.max_items_default', value: 50 },
    { key: 'check_listings.limit_default', value: 20 },
  ]

  const res = await request(appWith(db)).patch('/settings').set('authorization', AUTH).send({ updates })

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true })
  expect(db.calls).toHaveLength(1)
  expect(db.calls[0].sql).toContain('UPDATE settings')
  expect(db.calls[0].params).toEqual(['collect.max_items_default', 50, 'check_listings.limit_default', 20])
})

test('PATCH /settings answers 400 with the validation message and writes nothing for a bad update', async () => {
  const db = fakeDb()

  const res = await request(appWith(db))
    .patch('/settings')
    .set('authorization', AUTH)
    .send({ updates: [{ key: 'collect.max_items_default', value: 0 }] })

  expect(res.status).toBe(400)
  expect(res.body).toEqual({ error: 'collect.max_items_default must be >= 1' })
  expect(db.calls).toHaveLength(0)
})

test('PATCH /settings answers 400 when the body has no updates array', async () => {
  const res = await request(appWith(fakeDb())).patch('/settings').set('authorization', AUTH).send({})

  expect(res.status).toBe(400)
  expect(res.body).toEqual({ error: 'updates must be a non-empty array' })
})

test('settings routes need the bearer token', async () => {
  const res = await request(appWith(fakeDb())).get('/settings')

  expect(res.status).toBe(401)
})
