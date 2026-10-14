import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { AUTH_COOKIE_NAME } from '@/lib/auth'
import { decideProxy } from '@/lib/proxyDecision'

// Gate and front door for the whole dashboard. Order is fixed in
// lib/proxyDecision.ts: public paths, then the login cookie check, then
// migrated /api/* paths are rewritten to the VPS server with the bearer key
// injected here, so the browser only ever calls same-origin /api/* and never
// sees REFRESH_API_KEY. /api/login stays a Next handler (it sets the cookie).
//
// Known side effect: the VPS now sees Vercel egress IPs, not the browser's, so
// its per-IP failed-auth rate limiter (server/rateLimiter.ts) keys on Vercel.
// Acceptable: the bearer key is never typed by a user, so the limiter only
// guards against a wrong or leaked key, not password guessing.
//
export function proxy(request: NextRequest) {
  const decision = decideProxy({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    authCookie: request.cookies.get(AUTH_COOKIE_NAME)?.value,
    contentType: request.headers.get('content-type'),
    env: {
      DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD,
      REFRESH_SERVER_URL: process.env.REFRESH_SERVER_URL,
      REFRESH_API_KEY: process.env.REFRESH_API_KEY,
    },
  })

  switch (decision.kind) {
    case 'login':
      return NextResponse.redirect(new URL('/login', request.url))
    case 'unavailable':
      console.error(`REFRESH_SERVER_URL/REFRESH_API_KEY not set: cannot reach the server for ${decision.pathname}`)
      return NextResponse.json({ error: 'server not configured' }, { status: 503 })
    case 'rewrite':
      return NextResponse.rewrite(decision.target, { request: { headers: decision.headers } })
    case 'next':
      return NextResponse.next()
  }
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
}
