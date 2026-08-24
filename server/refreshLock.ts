export interface RefreshLock {
  isBusy(): boolean
  acquire(): void
  release(): void
}

// Shared between the single-listing refresh handler and the bulk
// product-refresh handler (see routes/refresh.ts and routes/refreshProduct.ts)
// - the VPS this runs on has ~2GB RAM, not enough for two concurrent
// Chromium instances, so the two use-cases must never run simultaneously
// either. Module-level state (not per-handler-scoped like the old busy flag
// used to be) precisely because it needs to be visible to both handlers.
export function createRefreshLock(): RefreshLock {
  let busy = false
  return {
    isBusy: () => busy,
    acquire: () => {
      busy = true
    },
    release: () => {
      busy = false
    },
  }
}
