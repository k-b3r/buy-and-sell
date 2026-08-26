import { createJobStore } from './jobState'

test('no job before anything starts', () => {
  const jobs = createJobStore()
  expect(jobs.current()).toBeNull()
})

test('start sets a running job with the given productId and total', () => {
  const jobs = createJobStore()
  jobs.start(5, 12)
  expect(jobs.current()).toEqual({ productId: 5, total: 12, completed: 0, status: 'running' })
})

test('recordCompletion increments the completed count', () => {
  const jobs = createJobStore()
  jobs.start(5, 12)
  jobs.recordCompletion()
  jobs.recordCompletion()
  expect(jobs.current()?.completed).toBe(2)
})

test('not cancel-requested until requestCancel is called', () => {
  const jobs = createJobStore()
  jobs.start(5, 12)
  expect(jobs.isCancelRequested()).toBe(false)
  jobs.requestCancel()
  expect(jobs.isCancelRequested()).toBe(true)
})

test('starting a new job resets the cancel-requested flag from a prior job', () => {
  const jobs = createJobStore()
  jobs.start(5, 12)
  jobs.requestCancel()
  jobs.start(6, 3)
  expect(jobs.isCancelRequested()).toBe(false)
})

test('finish sets the job status', () => {
  const jobs = createJobStore()
  jobs.start(5, 12)
  jobs.finish('completed')
  expect(jobs.current()?.status).toBe('completed')
})

test('starting a new job replaces the previous one - single slot, not a queue', () => {
  const jobs = createJobStore()
  jobs.start(5, 12)
  jobs.recordCompletion()
  jobs.start(6, 3)
  expect(jobs.current()).toEqual({ productId: 6, total: 3, completed: 0, status: 'running' })
})
