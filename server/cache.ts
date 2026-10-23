import type { RouteCache } from '../src/platform/cache'

const DEFAULT_TTL_MS = 300_000

// The contract routes and handlers depend on lives in src/platform/cache.ts
// (src/ never imports from server/); this is the in-memory implementation.
export type Cache = RouteCache

interface Entry {
  value: Promise<unknown>
  expiresAt: number
  tags: string[]
}

// In-memory, single-process: the server is one long-lived Node process on one
// box, and every dashboard write passes through it, so it can invalidate
// exactly. Workers write the DB directly; the ttl bounds how stale that gets
// (same 300 s the dashboard's unstable_cache used).
export function createCache({
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
}: { ttlMs?: number; now?: () => number } = {}): Cache {
  const entries = new Map<string, Entry>()

  return {
    wrap<T>(key: string, tags: string[], load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key)
      if (hit && hit.expiresAt > now()) return hit.value as Promise<T>

      const entry: Entry = { value: load(), expiresAt: now() + ttlMs, tags }
      entries.set(key, entry)
      // Failed loads are never cached. Only evict our own entry: an invalidate
      // or a newer load may have replaced it while this one was in flight.
      entry.value.catch(() => {
        if (entries.get(key) === entry) entries.delete(key)
      })
      return entry.value as Promise<T>
    },
    invalidate(...tags) {
      for (const [key, entry] of entries) {
        if (entry.tags.some((tag) => tags.includes(tag))) entries.delete(key)
      }
    },
  }
}
