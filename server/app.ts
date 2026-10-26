import { timingSafeEqual } from 'node:crypto'
import express from 'express'
import type { ErrorRequestHandler, Express, RequestHandler, Router } from 'express'
import { createRateLimiter } from './rateLimiter'
import type { RateLimiter } from './rateLimiter'

// Bearer token has no built-in lockout - without this, an internet-facing
// port is an unlimited-attempt brute-force target (confirmed as a real gap
// in the dashboard's own login route, 2026-08-24 - this server doesn't get
// the same hole). 10 failures/5min is generous for a legitimate caller
// (a typo or two) but slow enough to make guessing a real secret impractical.
const MAX_AUTH_FAILURES = 10
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000
const MAX_BODY_BYTES = '1mb'
const BEARER_PREFIX = 'Bearer '

export interface AppOptions {
  apiKey: string
  // Where handler failures go (detail stays in the box's log, never the response).
  log: (msg: string) => void
  routers?: Router[]
  rateLimiter?: RateLimiter
}

function tokenMatches(header: string | undefined, apiKey: string): boolean {
  if (!header?.startsWith(BEARER_PREFIX)) return false
  const given = Buffer.from(header.slice(BEARER_PREFIX.length))
  const expected = Buffer.from(apiKey)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function authMiddleware(apiKey: string, rateLimiter: RateLimiter): RequestHandler {
  return (req, res, next) => {
    const ip = req.ip ?? 'unknown'
    // Checked before the token, so a blocked IP is refused even with the right key.
    if (rateLimiter.isBlocked(ip)) {
      res.status(429).json({ error: 'too many failed attempts, try again later' })
      return
    }
    // Every route on this server is private - it's a personal companion
    // service to the collector scripts, nothing here is meant to be public.
    // One shared secret for all routes, checked here once, so a new route
    // never has to reimplement auth itself.
    if (!tokenMatches(req.headers.authorization, apiKey)) {
      rateLimiter.recordFailure(ip)
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    rateLimiter.recordSuccess(ip)
    next()
  }
}

function errorMiddleware(log: (msg: string) => void): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const type = (err as { type?: string }).type
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid JSON body' })
    } else if (type === 'entity.too.large') {
      res.status(413).json({ error: 'body too large' })
    } else {
      log(`${req.method} ${req.path} failed: ${err instanceof Error ? err.message : String(err)}`)
      res.status(500).json({ error: 'internal error' })
    }
  }
}

// JSON-in/JSON-out express app: rate limit and bearer auth for every request,
// then mount the routers server/index.ts builds - a module's routes.ts or a
// route file in routes/. This file owns only what every route shares.
export function createApp({
  apiKey,
  log,
  routers = [],
  rateLimiter = createRateLimiter(MAX_AUTH_FAILURES, AUTH_FAILURE_WINDOW_MS),
}: AppOptions): Express {
  const app = express()
  app.disable('x-powered-by')
  // Sits behind a Cloudflare Tunnel (loopback): trust it for the client IP so
  // the rate limiter keys on the real caller, not on 127.0.0.1.
  app.set('trust proxy', 'loopback')
  app.use(authMiddleware(apiKey, rateLimiter))
  // type: always - the old server JSON.parsed any body regardless of content type.
  app.use(express.json({ limit: MAX_BODY_BYTES, type: () => true }))
  for (const router of routers) app.use(router)
  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' })
  })
  app.use(errorMiddleware(log))
  return app
}
