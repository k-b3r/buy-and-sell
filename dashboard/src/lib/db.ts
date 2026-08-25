import { neon } from '@neondatabase/serverless'
import type { QueryClient } from './queries'

// neon() over plain `pg` Pool: each Vercel route is its own Lambda, so a
// module-level pg.Pool singleton rarely survives across navigations anyway -
// every "cold" hit paid a fresh TCP+TLS handshake to Neon (measured
// 300-500ms) on top of the query itself (~40ms). neon() issues each query as
// a plain HTTPS fetch with no connection setup at all, so there's no
// handshake to pay regardless of how cold the Lambda is. fullResults gives
// the {rows} shape QueryClient expects (same as pg's Result).
let client: QueryClient | undefined

export function getPool(): QueryClient {
  if (!client) {
    client = neon(process.env.DATABASE_URL!, { fullResults: true })
  }
  return client
}
