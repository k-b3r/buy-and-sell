import { NextResponse } from 'next/server'
import { AUTH_COOKIE_NAME, hashPassword } from '@/lib/auth'

export async function POST(request: Request) {
  const form = await request.formData()
  const password = form.get('password')
  const expected = process.env.DASHBOARD_PASSWORD

  if (typeof password !== 'string' || !expected || password !== expected) {
    return NextResponse.redirect(new URL('/login?error=1', request.url))
  }

  const response = NextResponse.redirect(new URL('/', request.url))
  response.cookies.set(AUTH_COOKIE_NAME, hashPassword(expected), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  })
  return response
}
