import { readFileSync } from 'node:fs'
import { extractGridListings } from './grid'

test('extracts listing-shaped objects from embedded JSON, keeping whatever fields exist', () => {
  const html = readFileSync('fixtures/grid-page.html', 'utf-8')
  const listings = extractGridListings(html)

  expect(listings).toHaveLength(2)
  expect(listings[0]).toMatchObject({
    id: '111',
    marketplace_listing_title: 'Sony WH-1000XM4',
  })
  expect(listings[1]).toMatchObject({ id: '222' })
})

test('returns empty array when no matching objects found', () => {
  expect(extractGridListings('<html><body>nothing here</body></html>')).toEqual([])
})
