import { createRateLimiter } from '../rateLimiter'

test('not blocked before any failures', () => {
  const limiter = createRateLimiter(3, 60000)
  expect(limiter.isBlocked('1.2.3.4')).toBe(false)
})

test('blocks an IP once it hits the failure threshold within the window', () => {
  const limiter = createRateLimiter(3, 60000)
  limiter.recordFailure('1.2.3.4')
  limiter.recordFailure('1.2.3.4')
  expect(limiter.isBlocked('1.2.3.4')).toBe(false)
  limiter.recordFailure('1.2.3.4')
  expect(limiter.isBlocked('1.2.3.4')).toBe(true)
})

test('tracks each IP independently', () => {
  const limiter = createRateLimiter(2, 60000)
  limiter.recordFailure('1.2.3.4')
  limiter.recordFailure('1.2.3.4')
  expect(limiter.isBlocked('1.2.3.4')).toBe(true)
  expect(limiter.isBlocked('5.6.7.8')).toBe(false)
})

test('old failures outside the window no longer count', () => {
  let currentTime = 0
  const limiter = createRateLimiter(2, 1000, () => currentTime)

  limiter.recordFailure('1.2.3.4')
  currentTime = 2000 // past the 1000ms window
  limiter.recordFailure('1.2.3.4')

  // only the second failure is still "recent" - one failure isn't enough to block
  expect(limiter.isBlocked('1.2.3.4')).toBe(false)
})

test('recordSuccess clears prior failures for that IP', () => {
  const limiter = createRateLimiter(2, 60000)
  limiter.recordFailure('1.2.3.4')
  limiter.recordFailure('1.2.3.4')
  expect(limiter.isBlocked('1.2.3.4')).toBe(true)

  limiter.recordSuccess('1.2.3.4')

  expect(limiter.isBlocked('1.2.3.4')).toBe(false)
})
