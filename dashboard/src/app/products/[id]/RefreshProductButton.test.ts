import { describe, expect, it } from 'vitest'
import { shouldRefreshPage } from './RefreshProductButton'

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
