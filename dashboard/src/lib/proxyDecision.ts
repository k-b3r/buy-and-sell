import { isAuthCookieValid } from './auth'
import { isServerRoute, serverRouteTarget } from './serverRoutes'

// Pure routing decision behind src/proxy.ts: what to do with a request, from
// plain data, so the auth order and the header allowlist are unit-testable
// without Next's request objects. proxy.ts turns the result into a
// NextResponse.

export interface ProxyEnv {
  DASHBOARD_PASSWORD?: string
  REFRESH_SERVER_URL?: string
  REFRESH_API_KEY?: string
}

export interface ProxyInput {
  pathname: string
  search: string
  authCookie: string | undefined
  contentType: string | null
  env: ProxyEnv
}

export type ProxyDecision =
  | { kind: 'next' }
  | { kind: 'login' }
  // The Next handlers for migrated paths are gone, so falling through would
  // be a bare 404: answer 503 instead.
  | { kind: 'unavailable'; pathname: string }
  | { kind: 'rewrite'; target: URL; headers: Headers }

// Reachable logged-out: the login page and handler, and robots.txt (crawlers
// don't have the auth cookie, so gating it would hide the Disallow directive;
// confirmed live 2026-08-24: it was redirecting to /login instead of serving
// the file).
const PUBLIC_PATHS = new Set(['/login', '/api/login', '/robots.txt'])

export function decideProxy({ pathname, search, authCookie, contentType, env }: ProxyInput): ProxyDecision {
  if (PUBLIC_PATHS.has(pathname)) return { kind: 'next' }

  if (!env.DASHBOARD_PASSWORD || !isAuthCookieValid(authCookie, env.DASHBOARD_PASSWORD)) {
    return { kind: 'login' }
  }

  // Resolved against the real routes table, so a path no entry matches (an
  // unmigrated /api sibling, a page) is never rewritten.
  if (!isServerRoute(pathname)) return { kind: 'next' }

  const target = env.REFRESH_SERVER_URL ? serverRouteTarget(pathname, search, env.REFRESH_SERVER_URL) : null
  if (!target || !env.REFRESH_API_KEY) return { kind: 'unavailable', pathname }

  // Allowlist, not a copy of the browser's headers: the dashboard auth cookie
  // and anything else the client sent must not reach the VPS.
  const headers = new Headers()
  if (contentType) headers.set('content-type', contentType)
  headers.set('authorization', `Bearer ${env.REFRESH_API_KEY}`)
  return { kind: 'rewrite', target, headers }
}
