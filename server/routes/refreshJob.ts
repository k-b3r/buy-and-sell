import type { RouteHandler, RouteResult } from '../app'
import type { JobStore } from '../jobState'

// Dashboard polls this while a bulk product-refresh job is running (see
// routes/refreshProduct.ts) - null means no job has ever started, or the
// server restarted since (job state is in-memory only, see jobState.ts).
export function createRefreshJobStatusHandler(jobs: JobStore): RouteHandler {
  return async function handleRefreshJobStatus(): Promise<RouteResult> {
    return { statusCode: 200, body: jobs.current() }
  }
}
