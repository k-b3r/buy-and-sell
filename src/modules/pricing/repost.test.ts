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

test('repostKey strips surrounding tabs, newlines and non-breaking spaces, not just plain spaces', () => {
  expect(repostKey({ id: 'a', title: '\t\u00a0iPhone 13\u3000\n ' })).toBe('iphone 13')
  expect(repostKey({ id: 'a', title: 'iPhone\u00a013' })).toBe('iphone\u00a013')
})

test('repostKeySql strips surrounding whitespace with a regex, lowercases, and falls back to the id column', () => {
  const sql = repostKeySql('title', 'listing_id')
  expect(sql).toMatch(/^COALESCE\(lower\(regexp_replace\(title, '.+', '', 'g'\)\), listing_id\)$/)
  expect(sql).toContain('\\u00a0')
})
