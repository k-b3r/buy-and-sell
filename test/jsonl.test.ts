import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { loadListings, saveListings } from '../src/jsonl'

const PATH = 'test/tmp-jsonl.jsonl'

afterEach(() => {
  if (existsSync(PATH)) rmSync(PATH)
})

test('loadListings returns an empty array when the file does not exist', () => {
  expect(loadListings(PATH)).toEqual([])
})

test('saveListings then loadListings round-trips listings', () => {
  saveListings(PATH, [
    { id: '1', title: 'A' },
    { id: '2', title: 'B' },
  ])
  expect(loadListings(PATH)).toEqual([
    { id: '1', title: 'A' },
    { id: '2', title: 'B' },
  ])
})

test('loadListings skips blank lines', () => {
  writeFileSync(PATH, '{"id":"1"}\n\n{"id":"2"}\n')
  expect(loadListings(PATH)).toEqual([{ id: '1' }, { id: '2' }])
})
