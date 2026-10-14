import request from 'supertest'
import { createApp } from '../app'
import { createRefreshJobStatusHandler } from './refreshJob'
import { createJobStore } from '../jobState'

test('returns null when no job has ever started', async () => {
  const handle = createRefreshJobStatusHandler(createJobStore())
  expect(await handle({})).toEqual({ statusCode: 200, body: null })
})

test('returns the current job state while running', async () => {
  const jobs = createJobStore()
  jobs.start(5, 10)
  jobs.recordCompletion()
  const handle = createRefreshJobStatusHandler(jobs)

  expect(await handle({})).toEqual({
    statusCode: 200,
    body: { productId: 5, total: 10, completed: 1, status: 'running' },
  })
})

test('GET /refresh-job through the app reports the current job', async () => {
  const jobs = createJobStore()
  jobs.start(5, 10)
  const app = createApp({
    apiKey: 'test-key',
    log: () => {},
    routes: { 'GET /refresh-job': createRefreshJobStatusHandler(jobs) },
  })

  const res = await request(app).get('/refresh-job').set('authorization', 'Bearer test-key')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ productId: 5, total: 10, completed: 0, status: 'running' })
})
