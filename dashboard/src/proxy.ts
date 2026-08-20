import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { AUTH_COOKIE_NAME, isAuthCookieValid } from '@/lib/auth'

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (pathname === '/login' || pathname === '/api/login') {
    return NextResponse.next()
  }

  const expected = process.env.DASHBOARD_PASSWORD
  const cookie = request.cookies.get(AUTH_COOKIE_NAME)?.value
  if (!expected || !isAuthCookieValid(cookie, expected)) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
}
