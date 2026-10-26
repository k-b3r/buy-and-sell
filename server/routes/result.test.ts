import express from 'express'
import request from 'supertest'
import { sendResult } from './result'

function appReturning(result: { statusCode: number; body: unknown }) {
  const app = express()
  app.get('/thing', (_req, res) => sendResult(res, result))
  return app
}

test('sendResult answers with the handler result status and JSON body', async () => {
  const res = await request(appReturning({ statusCode: 418, body: { error: 'teapot' } })).get('/thing')

  expect(res.status).toBe(418)
  expect(res.body).toEqual({ error: 'teapot' })
})

test('sendResult sends a null body as JSON null rather than an empty response', async () => {
  const res = await request(appReturning({ statusCode: 200, body: null })).get('/thing')

  expect(res.status).toBe(200)
  expect(res.text).toBe('null')
})
