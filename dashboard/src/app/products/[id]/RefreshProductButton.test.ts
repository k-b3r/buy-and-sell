import { describe, expect, it } from 'vitest'
import { resumableJob, shouldRefreshPage } from './RefreshProductButton'

describe('resumableJob', () => {
  const job = { productId: 7, total: 3, completed: 1, status: 'running' as const }

  it('resumes a job still running for this product', () => {
    expect(resumableJob(job, 7)).toEqual(job)
  })

  it('ignores a job that already finished before the page loaded, so the page is not refreshed on mount', () => {
    expect(resumableJob({ ...job, status: 'completed' }, 7)).toBeNull()
    expect(resumableJob({ ...job, status: 'cancelled' }, 7)).toBeNull()
  })

  it("ignores another product's job and an empty response", () => {
    expect(resumableJob(job, 8)).toBeNull()
    expect(resumableJob(null, 7)).toBeNull()
  })
})

describe('shouldRefreshPage', () => {
  it('refreshes when a running job completes', () => {
    expect(shouldRefreshPage('running', 'completed')).toBe(true)
  })

  it('refreshes when a running job is cancelled', () => {
    expect(shouldRefreshPage('running', 'cancelled')).toBe(true)
  })

  it('refreshes when the poll loses track of a running job', () => {
    expect(shouldRefreshPage('running', undefined)).toBe(true)
  })

  it('refreshes when a refresh with nothing to do finishes immediately', () => {
    expect(shouldRefreshPage(undefined, 'completed')).toBe(true)
  })

  it('does not refresh while a job is still running', () => {
    expect(shouldRefreshPage(undefined, 'running')).toBe(false)
    expect(shouldRefreshPage('running', 'running')).toBe(false)
  })

  it('does not refresh when there was never a job', () => {
    expect(shouldRefreshPage(undefined, undefined)).toBe(false)
  })
})
