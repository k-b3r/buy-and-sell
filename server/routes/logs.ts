import { open, stat } from 'node:fs/promises'
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
// Bounds every read regardless of how big the underlying log file gets - a
// worker stuck in a tight error loop can grow its log file past Node's 2GiB
// readFile/Buffer.alloc ceiling (confirmed live: a runaway `collect` loop
// produced a 16GB collector.log, and every request for its tail threw
// ERR_FS_FILE_TOO_LARGE uncaught, crash-looping this whole server). Reading
// a bounded slice from the end/offset instead of the whole file keeps this
// route correct no matter how large a log gets.
export const MAX_READ_BYTES = 1024 * 1024

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

async function readTail(filePath: string, size: number): Promise<{ lines: string[]; nextOffset: number }> {
  const length = Math.min(size, MAX_READ_BYTES)
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, size - length)
    return { lines: splitLines(buf.toString('utf8')).slice(-TAIL_LINES), nextOffset: size }
  } finally {
    await handle.close()
  }
}

// nextOffset only advances by what was actually read (not all the way to
// size) - a stale/zero offset against a huge file now takes several polls to
// catch up instead of one unbounded read, and the dashboard's existing poll
// loop already handles nextOffset < size by just asking again.
async function readFrom(filePath: string, offset: number, size: number): Promise<{ lines: string[]; nextOffset: number }> {
  const length = Math.min(size - offset, MAX_READ_BYTES)
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, offset)
    return { lines: splitLines(buf.toString('utf8')), nextOffset: offset + length }
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
        : await readTail(filePath, size)

    return { statusCode: 200, body: result }
  }
}
