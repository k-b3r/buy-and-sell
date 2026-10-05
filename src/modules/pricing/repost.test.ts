import { expect, test } from 'vitest'
import { computeRepostIds, repostKey, repostKeySql } from './repost'

test('computeRepostIds flags both listings when their titles are byte-identical', () => {
  const result = computeRepostIds([
    { id: 'a', title: 'iphone 13 256gb' },
    { id: 'b', title: 'iphone 13 256gb' },
  ])
  expect(result).toEqual(new Set(['a', 'b']))
})

test('computeRepostIds flags both listings when titles differ only in case or surrounding whitespace', () => {
  const result = computeRepostIds([
    { id: 'a', title: '  IPhone 13 256GB  ' },
    { id: 'b', title: 'iphone 13 256gb' },
  ])
  expect(result).toEqual(new Set(['a', 'b']))
})

test('computeRepostIds does not flag listings with distinct titles', () => {
  const result = computeRepostIds([
    { id: 'a', title: 'iphone 13 256gb' },
    { id: 'b', title: 'iphone 13 128gb' },
  ])
  expect(result).toEqual(new Set())
})

test('computeRepostIds flags all listings that share a title when three or more repeat it', () => {
  const result = computeRepostIds([
    { id: 'a', title: 'RTX 3060' },
    { id: 'b', title: 'RTX 3060' },
    { id: 'c', title: 'RTX 3060' },
  ])
  expect(result).toEqual(new Set(['a', 'b', 'c']))
})

test('computeRepostIds returns an empty set for an empty or single-listing list', () => {
  expect(computeRepostIds([])).toEqual(new Set())
  expect(computeRepostIds([{ id: 'a', title: 'RTX 3060' }])).toEqual(new Set())
})

test('repostKey keys an untitled listing on its own id so untitled listings never merge', () => {
  expect(repostKey({ id: 'a', title: null })).toBe('a')
  expect(
    computeRepostIds([
      { id: 'a', title: null },
      { id: 'b', title: null },
    ]),
  ).toEqual(new Set())
})

test('repostKeySql normalizes the title column and falls back to the id column', () => {
  expect(repostKeySql('title', 'listing_id')).toBe('COALESCE(lower(trim(title)), listing_id)')
})
