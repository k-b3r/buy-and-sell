import { readFileSync } from 'node:fs'
import { readDetailFields, readGridPage, readNextPage } from './page-reader'

// A realistic search page: one JSON block still holds the SSR listing payload
// while another carries the pagination token and the LSD token.
const GRID_HTML = [
  '<script type="application/json">{"require":[["LSD",[],{"token":"FAKE_LSD_TOKEN_0000000000"}]],"end_cursor":"{\\"pg\\":2}","has_next_page":true}</script>',
  '<script type="application/json">{"results":[{"id":"1","marketplace_listing_title":"Mic A"},{"id":"2","marketplace_listing_title":"Mic B"}]}</script>',
].join('\n')

test('readGridPage returns the grid listings with the cursor and LSD token the next page needs', () => {
  const page = readGridPage(GRID_HTML)

  expect(page.listings.map((l) => l.id)).toEqual(['1', '2'])
  expect(page.cursor).toEqual({ raw: '{"pg":2}', pg: 2 })
  expect(page.lsd).toBe('FAKE_LSD_TOKEN_0000000000')
})

test('readGridPage reports an empty, tokenless page rather than throwing on a page with nothing in it', () => {
  expect(readGridPage('<html><body>no listings</body></html>')).toEqual({
    listings: [],
    cursor: null,
    lsd: null,
  })
})

test('readNextPage returns the listings of a paginated page with its next cursor and page flag', () => {
  const page = readNextPage(readFileSync('fixtures/pagination-response.json', 'utf-8'))

  expect(page).not.toBeNull()
  expect(page!.listings.map((l) => l.id)).toEqual(['111', '222'])
  expect(page!.skipped).toBe(0)
  expect(page!.hasNextPage).toBe(true)
  expect(page!.nextCursor!.pg).toBe(1)
})

test('readNextPage keeps only the listing-shaped nodes and counts the ones it dropped', () => {
  const json = JSON.stringify({
    data: {
      marketplace_search: {
        feed_units: {
          edges: [
            { node: { listing: { id: '111', marketplace_listing_title: 'Mic' } } },
            { node: { listing: { id: 42, title: 'not a listing id' } } },
            { node: { listing: { story_key: 'no-id-here' } } },
          ],
          page_info: { end_cursor: '{"pg":1}', has_next_page: false },
        },
      },
    },
  })

  const page = readNextPage(json)

  expect(page!.listings.map((l) => l.id)).toEqual(['111'])
  expect(page!.skipped).toBe(2)
  expect(page!.hasNextPage).toBe(false)
})

test('readNextPage returns null when the response is not the pagination shape', () => {
  expect(readNextPage('not json')).toBeNull()
  expect(readNextPage('{"errors":[{"message":"boom"}]}')).toBeNull()
})

test('readDetailFields returns the listing fields a detail page carries', () => {
  const fields = readDetailFields(readFileSync('fixtures/detail-page.html', 'utf-8'))

  expect(fields.id).toBe('111')
  expect(fields.condition).toBe('Used - like new')
})
