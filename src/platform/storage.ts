import { Pool } from 'pg'

export interface DbClient {
  query(sql: string, params: unknown[]): Promise<unknown>
}

// DbClient narrowed to pg's result shape, for queries that map rows.
export interface QueryClient {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>
}

export function createDbPool(connectionString: string): Pool {
  return new Pool({ connectionString })
}
