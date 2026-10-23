// The cache contract every module router and refresh handler depends on.
// server/cache.ts implements it; src/ never imports from server/, so the shared
// shape lives here and the server's Cache is one implementation of it.
//
// A reader wraps its loads with tags so a write can drop exactly the reads it
// makes stale; a writer only needs to invalidate.
export interface CacheInvalidator {
  invalidate(...tags: string[]): void
}

export interface RouteCache extends CacheInvalidator {
  // Returns the cached value for key, or runs load once and caches it.
  wrap<T>(key: string, tags: string[], load: () => Promise<T>): Promise<T>
}
