import { readFileSync, rmSync, existsSync } from 'node:fs'
import { appendApprovedListing } from '../src/output'

const OUT_PATH = 'test/tmp-listings.jsonl'

afterEach(() => {
  if (existsSync(OUT_PATH)) rmSync(OUT_PATH)
})

test('appends one JSON object per line', () => {
  appendApprovedListing(OUT_PATH, { id: '1', title: 'Sony WH-1000XM4' })
  appendApprovedListing(OUT_PATH, { id: '2', title: 'Audio-Technica ATH-M50x' })

  const lines = readFileSync(OUT_PATH, 'utf-8').trim().split('\n')
  expect(lines).toHaveLength(2)
  expect(JSON.parse(lines[0])).toEqual({ id: '1', title: 'Sony WH-1000XM4' })
  expect(JSON.parse(lines[1])).toEqual({ id: '2', title: 'Audio-Technica ATH-M50x' })
})
