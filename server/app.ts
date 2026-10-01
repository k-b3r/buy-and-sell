import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createRateLimiter } from './rateLimiter'
import type { RateLimiter } from './rateLimiter'

export interface RouteResult {
  statusCode: number
  body: unknown
}

export type RouteHandler = (body: unknown) => Promise<RouteResult>

// Key format: "METHOD /path" (e.g. "POST /refresh") - exact match only, no
// path params. Every route on this server is body-driven (ids/etc arrive in
// the JSON body, not the URL), which is enough for what's here and what's
// anticipated - a path-param matcher can be added if a future use case
// genuinely needs one, not before.
export type RouteTable = Record<string, RouteHandler>

// Bearer token has no built-in lockout - without this, an internet-facing
// port is an unlimited-attempt brute-force target (confirmed as a real gap
// in the dashboard's own login route, 2026-08-24 - this server doesn't get
// the same hole). 10 failures/5min is generous for a legitimate caller
// (a typo or two) but slow enough to make guessing a real secret impractical.
const MAX_AUTH_FAILURES = 10
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000

// Pure routing/auth/JSON-parsing core, no Node http types involved - testable
// directly without spinning up a real server or faking IncomingMessage/
// ServerResponse. createApp below is just a thin Node adapter around this.
export async function handleRequest(
  routes: RouteTable,
  apiKey: string,
  method: string | undefined,
  url: string | undefined,
  authHeader: string | undefined,
  rawBody: string,
  clientIp: string,
  rateLimiter: RateLimiter,
): Promise<RouteResult> {
  const handler = routes[`${method} ${url}`]
  if (!handler) {
    return { statusCode: 404, body: { error: 'not found' } }
  }

  if (rateLimiter.isBlocked(clientIp)) {
    return { statusCode: 429, body: { error: 'too many failed attempts, try again later' } }
  }

  // Every route on this server is private - it's a personal companion
  // service to the collector scripts, nothing here is meant to be public.
  // One shared secret for all routes, checked here once, so a new route
  // never has to reimplement auth itself.
  if (authHeader !== `Bearer ${apiKey}`) {
    rateLimiter.recordFailure(clientIp)
    return { statusCode: 401, body: { error: 'unauthorized' } }
  }
  rateLimiter.recordSuccess(clientIp)

  let body: unknown
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return { statusCode: 400, body: { error: 'invalid JSON body' } }
  }
  return handler(body)
}

// x-forwarded-for is only trustworthy once this sits behind a proxy/tunnel
// (Cloudflare Tunnel, per the plan this is a step toward) - until then it's
// unset and this falls back to the raw socket address, same as today.
function clientIpFrom(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim()
  return req.socket.remoteAddress ?? 'unknown'
}

// Generic JSON-in/JSON-out HTTP app - register a route table, get a plain
// Node http.Server back. New use cases add an entry to the route table
// passed in at the call site (see index.ts), not a change to this file.
export function createApp(apiKey: string, routes: RouteTable): Server {
  const rateLimiter = createRateLimiter(MAX_AUTH_FAILURES, AUTH_FAILURE_WINDOW_MS)

  return createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', async () => {
      const clientIp = clientIpFrom(req)
      const result = await handleRequest(
        routes,
        apiKey,
        req.method,
        req.url,
        req.headers.authorization,
        raw,
        clientIp,
        rateLimiter,
      )
      res.writeHead(result.statusCode, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.body))
    })
  })
}
