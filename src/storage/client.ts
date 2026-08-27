import { Pool } from 'pg'

export interface DbClient {
  query(sql: string, params: unknown[]): Promise<unknown>
}

export function createDbPool(connectionString: string): Pool {
  return new Pool({ connectionString })
}
