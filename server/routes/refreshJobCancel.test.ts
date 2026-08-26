import { createCancelRefreshJobHandler } from './refreshJobCancel'
import { createJobStore } from '../jobState'

test('400s when no job is running', async () => {
  const jobs = createJobStore()
  const handle = createCancelRefreshJobHandler(jobs)

  expect(await handle({})).toEqual({ statusCode: 400, body: { error: 'no refresh job in progress' } })
})

test('400s when the last job already finished', async () => {
  const jobs = createJobStore()
  jobs.start(5, 10)
  jobs.finish('completed')
  const handle = createCancelRefreshJobHandler(jobs)

  expect(await handle({})).toEqual({ statusCode: 400, body: { error: 'no refresh job in progress' } })
})

test('requests cancellation of a running job', async () => {
  const jobs = createJobStore()
  jobs.start(5, 10)
  const handle = createCancelRefreshJobHandler(jobs)

  const result = await handle({})

  expect(result).toEqual({ statusCode: 200, body: { productId: 5, total: 10, completed: 0, status: 'running' } })
  expect(jobs.isCancelRequested()).toBe(true)
})
