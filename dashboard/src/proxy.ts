import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { AUTH_COOKIE_NAME, isAuthCookieValid } from '@/lib/auth'
import { isServerRoute, serverRouteTarget } from '@/lib/serverRoutes'

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  // robots.txt must be reachable logged-out - crawlers don't have the auth
  // cookie, so gating it here would hide the Disallow directive from the
  // exact audience it's meant for (confirmed live 2026-08-24: it was
  // redirecting to /login instead of serving the file).
  if (pathname === '/login' || pathname === '/api/login' || pathname === '/robots.txt') {
    return NextResponse.next()
  }

  const expected = process.env.DASHBOARD_PASSWORD
  const cookie = request.cookies.get(AUTH_COOKIE_NAME)?.value
  if (!expected || !isAuthCookieValid(cookie, expected)) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (isServerRoute(pathname)) {
    const serverUrl = process.env.REFRESH_SERVER_URL
    const apiKey = process.env.REFRESH_API_KEY
    const target = serverUrl ? serverRouteTarget(pathname, request.nextUrl.search, serverUrl) : null
    if (!target || !apiKey) {
      // The Next handlers are gone, so falling through would be a bare 404.
      console.error(`REFRESH_SERVER_URL/REFRESH_API_KEY not set: cannot reach the server for ${pathname}`)
      return NextResponse.json({ error: 'server not configured' }, { status: 503 })
    }
    // Forward only what the server needs; the browser's own cookies (the
    // dashboard auth cookie) must not reach the VPS.
    const headers = new Headers()
    const contentType = request.headers.get('content-type')
    if (contentType) headers.set('content-type', contentType)
    headers.set('authorization', `Bearer ${apiKey}`)
    return NextResponse.rewrite(target, { request: { headers } })
  }

  return NextResponse.next()
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
}
