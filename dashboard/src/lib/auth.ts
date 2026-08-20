import { createHash } from 'node:crypto'

export const AUTH_COOKIE_NAME = 'dashboard_auth'

export function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex')
}

export function isAuthCookieValid(cookieValue: string | undefined, expectedPassword: string): boolean {
  if (!cookieValue) return false
  return cookieValue === hashPassword(expectedPassword)
}
