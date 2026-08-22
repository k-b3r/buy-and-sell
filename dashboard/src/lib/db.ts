import { Pool } from 'pg'
import type { QueryClient } from './queries'

let pool: Pool | undefined

export function getPool(): QueryClient {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
  }
  return pool
}
