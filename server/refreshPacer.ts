import type { DelayFn } from '../src/platform/delay'
import { realDelay } from '../src/platform/delay'
import type { RefreshLock } from './refreshLock'

// Same human-paced gap as the CLI's batch loop and the bulk product-refresh
// handler - a single-listing refresh hitting live Facebook gets no less
// pacing than either of those.
const MIN_PAUSE_MS = 4000
const MAX_PAUSE_MS = 10000

// Bounded, not unlimited - a caller queued behind a multi-minute bulk job
// would sit long enough to time out the dashboard's own Vercel API route
// anyway, so there's no point waiting that long. A couple of quick
// single-listing requests ahead of it comfortably finish within this.
const MAX_QUEUE_WAIT_MS = 90_000
const POLL_INTERVAL_MS = 500

export interface RefreshPacer {
  // Waits for the shared lock to free (bounded by MAX_QUEUE_WAIT_MS) and for
  // the minimum pacing gap since the last completed action, then acquires
  // the lock itself. Returns false if it timed out still busy - the caller
  // should treat that as "still busy, give up" (429), not proceed (and must
  // not call release()/recordActionComplete() in that case - nothing was
  // acquired).
  waitForTurn(): Promise<boolean>
  // Releases the lock waitForTurn acquired - call once the caller's own work
  // is done, mirroring RefreshLock.release() (this wraps it, not a
  // replacement for the underlying lock).
  release(): void
  // Called by whoever's turn just finished (single-listing refresh, or the
  // bulk handler after its own loop) - marks "this is when we last actually
  // touched Facebook" so the NEXT caller's pacing gap is measured against
  // reality, not just against other single-listing requests.
  recordActionComplete(): void
}

export function createRefreshPacer(
  lock: RefreshLock,
  now: () => number = Date.now,
  delay: DelayFn = realDelay,
): RefreshPacer {
  let lastActionAt: number | null = null

  return {
    async waitForTurn() {
      const deadline = now() + MAX_QUEUE_WAIT_MS
      while (lock.isBusy()) {
        if (now() >= deadline) return false
        await delay(POLL_INTERVAL_MS)
      }
      lock.acquire()

      if (lastActionAt !== null) {
        const targetGap = MIN_PAUSE_MS + Math.random() * (MAX_PAUSE_MS - MIN_PAUSE_MS)
        const remaining = targetGap - (now() - lastActionAt)
        if (remaining > 0) await delay(remaining)
      }
      return true
    },
    release() {
      lock.release()
    },
    recordActionComplete() {
      lastActionAt = now()
    },
  }
}
