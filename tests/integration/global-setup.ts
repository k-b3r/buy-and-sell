import { readFileSync } from 'node:fs'
import { Client } from 'pg'

// Deliberately not DATABASE_URL: that points at prod in local .env files, and
// these tests write to the database they're given.
export const TEST_DATABASE_URL_ENV = 'TEST_DATABASE_URL'

export function testDatabaseUrl(): string {
  const url = process.env[TEST_DATABASE_URL_ENV]
  if (!url) throw new Error(`${TEST_DATABASE_URL_ENV} not set - point it at a disposable Postgres database`)
  return url
}

// Applies db/schema.sql to the test database, the same way prod gets migrated.
export default async function setup() {
  const client = new Client({ connectionString: testDatabaseUrl() })
  await client.connect()
  try {
    // schema.sql grants to the prod roles, so they must exist for it to apply.
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'server_service') THEN CREATE ROLE server_service; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'neondb_owner') THEN CREATE ROLE neondb_owner; END IF;
    END $$`)
    await client.query(readFileSync('db/schema.sql', 'utf8'))
  } finally {
    await client.end()
  }
}
