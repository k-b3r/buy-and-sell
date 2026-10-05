import { isBrowserUnusableError } from './driver'

test('isBrowserUnusableError flags a crashed page and a closed browser as needing a fresh browser', () => {
  expect(isBrowserUnusableError(new Error('page.goto: Page crashed'))).toBe(true)
  expect(isBrowserUnusableError(new Error('page.content: Target page, context or browser has been closed'))).toBe(true)
})

test('isBrowserUnusableError leaves ordinary navigation errors and non-errors to a plain retry', () => {
  expect(isBrowserUnusableError(new Error('page.goto: net::ERR_TIMED_OUT'))).toBe(false)
  expect(isBrowserUnusableError('Page crashed')).toBe(false)
})
