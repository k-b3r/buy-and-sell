import { open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RouteHandler, RouteResult } from '../app'

export const WORKER_LOG_FILES: Record<string, string> = {
  collect: 'collector.log',
  'check-listings': 'check-listings.log',
  'extract-products': 'extract-products.log',
  'enrich-products': 'enrich-products.log',
  'price-lookup': 'price-lookup.log',
  'enrich-listing-prices': 'enrich-listing-prices.log',
  'verify-discount-notifications': 'verify-discount-notifications.log',
}

const TAIL_LINES = 200

// index.ts runs with CWD set to server/ (its .env resolves relative to CWD),
// so a CWD-relative path would land in server/data instead of the repo-root
// data/ dir every worker actually writes to. Resolve from this module's own
// location instead: server/routes/ -> .. = server/ -> ../.. = repo root.
const defaultDataDir = path.join(fileURLToPath(new URL('.', import.meta.url)), '../../data')

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

async function readTail(filePath: string): Promise<{ lines: string[]; nextOffset: number }> {
  const buf = await readFile(filePath)
  return { lines: splitLines(buf.toString('utf8')).slice(-TAIL_LINES), nextOffset: buf.byteLength }
}

async function readFrom(filePath: string, offset: number, size: number): Promise<{ lines: string[]; nextOffset: number }> {
  const length = size - offset
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, offset)
    return { lines: splitLines(buf.toString('utf8')), nextOffset: size }
  } finally {
    await handle.close()
  }
}

// Dashboard's /admin/logs page - tails a worker's log file. worker is a key
// into the allowlist above, never a raw path, so path traversal is closed
// off by construction rather than by sanitizing input.
export function createLogsHandler(dataDir: string = defaultDataDir): RouteHandler {
  return async function handleLogs(body: unknown): Promise<RouteResult> {
    const req = (body as Record<string, unknown> | null) ?? {}
    const worker = req.worker
    if (typeof worker !== 'string' || !(worker in WORKER_LOG_FILES)) {
      return { statusCode: 400, body: { error: 'unknown "worker"' } }
    }
    const filePath = path.join(dataDir, WORKER_LOG_FILES[worker])

    let size: number
    try {
      size = (await stat(filePath)).size
    } catch {
      return { statusCode: 200, body: { lines: [], nextOffset: 0 } }
    }

    const offset = req.offset
    const result =
      typeof offset === 'number' && offset >= 0 && offset <= size
        ? await readFrom(filePath, offset, size)
        : await readTail(filePath)

    return { statusCode: 200, body: result }
  }
}
