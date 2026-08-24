import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger } from '../src/logger'
import { createLogger } from '../src/logger'
import type { DbClient } from '../src/db'
import { createDbPool, getListingCheckCandidate } from '../src/db'
import type { ImageStore } from '../src/images'
import { createR2ImageStore } from '../src/images'
import type { PageDriver } from '../src/driver'
import { launchBrowser, createBrowserDriver } from '../src/browser'
import { checkOneListing } from '../src/check-listings'

export interface RefreshResult {
  statusCode: number
  body: { status: string } | { error: string }
}

export type DriverFactory = () => Promise<{ driver: PageDriver; close: () => Promise<void> }>

const defaultDriverFactory: DriverFactory = async () => {
  const { page, close } = await launchBrowser()
  return { driver: createBrowserDriver(page), close }
}

// Dashboard's "Refresh" button (on-demand, one listing at a time) lands here
// rather than the batch getCheckListingsCandidates backlog - see checkOneListing
// for the shared core logic. Returns a plain result object rather than writing
// to an HTTP response directly, so the request/response parsing (JSON body,
// headers) and the actual refresh logic can be tested independently.
export function createRefreshHandler(
  apiKey: string,
  db: DbClient,
  imageStore: ImageStore,
  logger: Logger,
  driverFactory: DriverFactory = defaultDriverFactory,
) {
  // Closure-scoped, not module-level - the VPS this runs on has ~2GB RAM
  // (confirmed live 2026-08-23), not enough headroom for two concurrent
  // Chromium instances. A second request while one's in flight gets a clean
  // 429 rather than risking an OOM kill of both. Scoped per-handler (not a
  // module-level flag) so tests creating separate handlers don't share state.
  let busy = false

  return async function handleRefreshRequest(id: unknown, authHeader: string | undefined): Promise<RefreshResult> {
    if (authHeader !== `Bearer ${apiKey}`) {
      return { statusCode: 401, body: { error: 'unauthorized' } }
    }
    if (typeof id !== 'string' || id.trim() === '') {
      return { statusCode: 400, body: { error: 'missing or invalid "id"' } }
    }
    if (busy) {
      return { statusCode: 429, body: { error: 'a refresh is already in progress, try again shortly' } }
    }

    busy = true
    try {
      const candidate = await getListingCheckCandidate(db, id)
      if (!candidate) {
        return { statusCode: 404, body: { error: `listing ${id} not found` } }
      }

      const { driver, close } = await driverFactory()
      try {
        logger.info(`on-demand refresh: listing ${id}`)
        await driver.openListing({ id })
        const result = await checkOneListing(driver, db, imageStore, logger, candidate)
        return { statusCode: 200, body: { status: result.status } }
      } finally {
        await close()
      }
    } finally {
      busy = false
    }
  }
}

// Run from within server/ (`pnpm start` / `pnpm dev`) - .env is resolved
// relative to CWD, so this expects server/.env, a separate file from the
// root scripts' .env (mirrors dashboard/.env.local being its own file too).
async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const apiKey = process.env.REFRESH_API_KEY
  if (!apiKey) throw new Error('REFRESH_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — refresh-server requires Postgres')

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL } = process.env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_BASE_URL) {
    throw new Error('R2 not fully configured in .env — refresh-server needs to be able to delete photos')
  }

  const port = Number(process.env.REFRESH_SERVER_PORT ?? 8787)

  const logger = createLogger('refresh-server.log')
  const pool = createDbPool(dbUrl)
  const imageStore = createR2ImageStore({
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_KEY,
    bucket: R2_BUCKET_NAME,
    publicBaseUrl: R2_PUBLIC_BASE_URL,
  })
  const handleRefreshRequest = createRefreshHandler(apiKey, pool, imageStore, logger)

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/refresh') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', async () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid JSON body' }))
        return
      }
      const id = (parsed as Record<string, unknown>).id
      const result = await handleRefreshRequest(id, req.headers.authorization)
      res.writeHead(result.statusCode, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.body))
    })
  })

  server.listen(port, () => {
    logger.info(`refresh server listening on port ${port}`)
  })
}

// Guard so importing this module (e.g. from tests) doesn't also start the
// server — see other scripts' main() guard for the same precedent.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
