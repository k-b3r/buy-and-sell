import { readFileSync } from 'node:fs'
import { extractDetailFields } from '../../src/extract/detail'

test('extracts the richest listing-shaped object with all its fields', () => {
  const html = readFileSync('fixtures/detail-page.html', 'utf-8')
  const detail = extractDetailFields(html)

  expect(detail.id).toBe('111')
  expect(detail.condition).toBe('Used - like new')
  expect(detail.redacted_description).toEqual({ text: 'Barely used, comes with case and cable.' })
})

test('merges the full photo carousel from a same-id media-viewer stub into the main listing object', () => {
  const html = readFileSync('fixtures/detail-page.html', 'utf-8')
  const detail = extractDetailFields(html)

  expect(detail.id).toBe('111')
  // main object's own fields survive the merge
  expect(detail.condition).toBe('Used - like new')
  // carousel photos merged in from the separate media-viewer query block
  expect(detail.listing_photos).toEqual([
    { image: { uri: 'https://example.com/carousel-1.jpg' } },
    { image: { uri: 'https://example.com/carousel-2.jpg' } },
    { image: { uri: 'https://example.com/carousel-3.jpg' } },
  ])
})

test('does not pull in a photo carousel belonging to a different listing id', () => {
  const html = `<script type="application/json">{
    "target": { "id": "111", "marketplace_listing_title": "Mic", "listing_price": { "amount": "100" } }
  }</script>
  <script type="application/json">{
    "target": { "id": "999", "listing_photos": [{ "image": { "uri": "https://example.com/other.jpg" } }] }
  }</script>`
  const detail = extractDetailFields(html)

  expect(detail.id).toBe('111')
  expect(detail.listing_photos).toBeUndefined()
})

test('returns empty object when nothing found', () => {
  expect(extractDetailFields('<html></html>')).toEqual({})
})
