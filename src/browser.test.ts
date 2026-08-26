import { shouldBlockResource } from '../src/browser'

test('blocks image, font, stylesheet, and media resource types', () => {
  expect(shouldBlockResource('image')).toBe(true)
  expect(shouldBlockResource('font')).toBe(true)
  expect(shouldBlockResource('stylesheet')).toBe(true)
  expect(shouldBlockResource('media')).toBe(true)
})

test('does not block document, script, fetch, or xhr resource types', () => {
  expect(shouldBlockResource('document')).toBe(false)
  expect(shouldBlockResource('script')).toBe(false)
  expect(shouldBlockResource('fetch')).toBe(false)
  expect(shouldBlockResource('xhr')).toBe(false)
})
