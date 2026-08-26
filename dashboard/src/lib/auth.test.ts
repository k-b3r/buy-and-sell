import { expect, test } from 'vitest'
import { hashPassword, isAuthCookieValid, AUTH_COOKIE_NAME } from '../src/lib/auth'

test('AUTH_COOKIE_NAME is a stable, non-empty cookie name', () => {
  expect(AUTH_COOKIE_NAME).toBe('dashboard_auth')
})

test('hashPassword returns the same hash for the same input, different hashes for different input', () => {
  expect(hashPassword('secret')).toBe(hashPassword('secret'))
  expect(hashPassword('secret')).not.toBe(hashPassword('different'))
})

test('isAuthCookieValid accepts a cookie matching hashPassword(expectedPassword)', () => {
  const expected = 'correct-horse-battery-staple'
  expect(isAuthCookieValid(hashPassword(expected), expected)).toBe(true)
})

test('isAuthCookieValid rejects a missing or wrong cookie', () => {
  const expected = 'correct-horse-battery-staple'
  expect(isAuthCookieValid(undefined, expected)).toBe(false)
  expect(isAuthCookieValid('garbage', expected)).toBe(false)
  expect(isAuthCookieValid(hashPassword('wrong-password'), expected)).toBe(false)
})
