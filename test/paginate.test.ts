import { readFileSync } from 'node:fs'
import { extractCursor, extractLsd, parsePaginationResponse } from '../src/paginate'

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

test('parsePaginationResponse extracts nodes and next cursor', () => {
  const json = readFileSync('fixtures/pagination-response.json', 'utf-8')
  const page = parsePaginationResponse(json)
  expect(page).not.toBeNull()
  expect(page!.nodes).toHaveLength(2)
  expect(page!.nodes[0].id).toBe('111')
  expect(page!.hasNextPage).toBe(true)
  expect(page!.nextCursor!.pg).toBe(1)
})

test('parsePaginationResponse handles empty edges (the live params-mismatch case)', () => {
  const json = readFileSync('fixtures/pagination-response-empty.json', 'utf-8')
  const page = parsePaginationResponse(json)
  expect(page!.nodes).toHaveLength(0)
  expect(page!.hasNextPage).toBe(false)
})

test('parsePaginationResponse returns null on unexpected shape', () => {
  expect(parsePaginationResponse('{"errors":[{"message":"boom"}]}')).toBeNull()
  expect(parsePaginationResponse('not json')).toBeNull()
})

test('parsePaginationResponse drops edges with a missing node', () => {
  const json = JSON.stringify({
    data: {
      marketplace_search: {
        feed_units: {
          edges: [{ node: { id: '111' } }, { cursor: 'no-node-here' }],
          page_info: { end_cursor: '{"pg":1}', has_next_page: true },
        },
      },
    },
  })
  const page = parsePaginationResponse(json)
  expect(page).not.toBeNull()
  expect(page!.nodes).toHaveLength(1)
  expect(page!.nodes[0].id).toBe('111')
})

test('extractCursor returns null on malformed cursor JSON', () => {
  const html = '<script>"end_cursor":"not-json-at-all"</script>'
  expect(extractCursor(html)).toBeNull()
})
