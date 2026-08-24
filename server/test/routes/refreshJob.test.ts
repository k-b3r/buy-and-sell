import { createRefreshJobStatusHandler } from '../../routes/refreshJob'
import { createJobStore } from '../../jobState'

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
