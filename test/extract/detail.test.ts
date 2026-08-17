import { readFileSync } from 'node:fs'
import { extractDetailFields } from '../../src/extract/detail'

test('extracts the richest listing-shaped object with all its fields', () => {
  const html = readFileSync('fixtures/detail-page.html', 'utf-8')
  const detail = extractDetailFields(html)

  expect(detail.id).toBe('111')
  expect(detail.condition).toBe('Used - like new')
  expect(detail.redacted_description).toEqual({ text: 'Barely used, comes with case and cable.' })
})

test('returns empty object when nothing found', () => {
  expect(extractDetailFields('<html></html>')).toEqual({})
})
