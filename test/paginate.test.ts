import { readFileSync } from 'node:fs'
import { extractCursor, extractLsd } from '../src/paginate'

test('extractCursor reads pg and keeps raw string for reuse', () => {
  const html = readFileSync('fixtures/ssr-page-with-cursor.html', 'utf-8')
  const cursor = extractCursor(html)
  expect(cursor).not.toBeNull()
  expect(cursor!.pg).toBe(0)
  expect(cursor!.raw).toContain('OPAQUE_TOKEN_ABC')
})

test('extractCursor returns null when no cursor present', () => {
  expect(extractCursor('<html></html>')).toBeNull()
})

test('extractLsd reads the LSD token', () => {
  const html = readFileSync('fixtures/ssr-page-with-cursor.html', 'utf-8')
  expect(extractLsd(html)).toBe('FAKE_LSD_TOKEN_0000000000')
})

test('extractLsd returns null when absent', () => {
  expect(extractLsd('<html></html>')).toBeNull()
})
