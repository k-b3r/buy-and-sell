import { isQuotaError } from './error-classification'

export interface ClientPoolOptions {
  // Names the provider in the empty-pool error ("all Groq clients exhausted").
  provider: string
  // 'sticky' stays on one client until it is exhausted (best-first chains:
  // models on a key, a primary key and its spare). 'round-robin' rotates on
  // every successful call so load spreads across keys.
  strategy?: 'sticky' | 'round-robin'
  // What counts as "this client is done for the run". Defaults to the shared
  // quota rule (429); Exa and OpenRouter add their 402 credits signal.
  isExhausted?: (err: unknown) => boolean
  // Human-readable name per client, only for onFallback ("GROQ_API_KEY0",
  // model names); "client <i>" when omitted.
  labels?: string[]
  // Fired once per drop, so a worker can log "falling back to X" without
  // knowing the rotation logic.
  onFallback?: (fromLabel: string, toLabel: string) => void
}

export type PooledCall<C> = <T>(call: (client: C) => Promise<T>) => Promise<T>

// The one fallback/round-robin loop every provider wrapper plugs into.
// Contract: an exhausted client is dropped for the rest of the process (its
// quota or credits will not come back mid-run) and the same call moves on to
// the next one; the last client is never dropped, so its exhaustion error is
// rethrown for the caller's retry/stop logic. Any other error is rethrown
// immediately without switching: callers' retry loops own transient failures.
export function createClientPool<C>(clients: C[], options: ClientPoolOptions): PooledCall<C> {
  const isExhausted = options.isExhausted ?? isQuotaError
  const rotate = options.strategy === 'round-robin'
  const pool = clients.map((client, index) => ({ client, label: options.labels?.[index] ?? `client ${index}` }))
  let nextIndex = 0

  return async <T>(call: (client: C) => Promise<T>): Promise<T> => {
    while (pool.length > 0) {
      const index = nextIndex % pool.length
      try {
        const result = await call(pool[index].client)
        if (rotate) nextIndex = index + 1
        return result
      } catch (err) {
        if (isExhausted(err) && pool.length > 1) {
          const [dropped] = pool.splice(index, 1)
          options.onFallback?.(dropped.label, pool[index % pool.length].label)
          continue
        }
        throw err
      }
    }
    throw new Error(`all ${options.provider} clients exhausted`)
  }
}
