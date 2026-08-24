import type { RouteHandler, RouteResult } from '../app'
import type { JobStore } from '../jobState'

// The loop in routes/refreshProduct.ts only checks isCancelRequested()
// between candidates, so cancellation is cooperative, not immediate - it
// stops before the *next* listing, not mid-request.
export function createCancelRefreshJobHandler(jobs: JobStore): RouteHandler {
  return async function handleCancelRefreshJob(): Promise<RouteResult> {
    const job = jobs.current()
    if (!job || job.status !== 'running') {
      return { statusCode: 400, body: { error: 'no refresh job in progress' } }
    }
    jobs.requestCancel()
    return { statusCode: 200, body: job }
  }
}
