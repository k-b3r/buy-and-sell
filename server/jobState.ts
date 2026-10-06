interface RefreshJob {
  productId: number
  total: number
  completed: number
  status: 'running' | 'completed' | 'cancelled' | 'failed'
}

export interface JobStore {
  current(): RefreshJob | null
  start(productId: number, total: number): void
  recordCompletion(): void
  requestCancel(): void
  isCancelRequested(): boolean
  finish(status: 'completed' | 'cancelled' | 'failed'): void
}

// Single in-memory slot, not a map keyed by productId - the shared
// RefreshLock already guarantees only one job (bulk or single-listing) runs
// server-wide at a time, so there's never more than one job to track.
// Lost on server restart - accepted tradeoff, see the design discussion:
// a crash mid-batch just means the dashboard's next poll sees no job
// running, same as if it had never started.
export function createJobStore(): JobStore {
  let job: RefreshJob | null = null
  let cancelRequested = false

  return {
    current: () => job,
    start: (productId, total) => {
      cancelRequested = false
      job = { productId, total, completed: 0, status: 'running' }
    },
    recordCompletion: () => {
      if (job) job.completed += 1
    },
    requestCancel: () => {
      cancelRequested = true
    },
    isCancelRequested: () => cancelRequested,
    finish: (status) => {
      if (job) job.status = status
    },
  }
}
