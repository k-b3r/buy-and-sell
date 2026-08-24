import { expect, test } from 'vitest'
import { computeRepostIds } from '../src/app/products/[id]/repostDetection'

test('flags both listings when their titles are byte-identical', () => {
  const result = computeRepostIds([
    { id: 'a', title: 'iphone 13 256gb' },
    { id: 'b', title: 'iphone 13 256gb' },
  ])
  expect(result).toEqual(new Set(['a', 'b']))
})

test('flags both listings when titles differ only in case or surrounding whitespace', () => {
  const result = computeRepostIds([
    { id: 'a', title: '  IPhone 13 256GB  ' },
    { id: 'b', title: 'iphone 13 256gb' },
  ])
  expect(result).toEqual(new Set(['a', 'b']))
})

test('does not flag listings with distinct titles', () => {
  const result = computeRepostIds([
    { id: 'a', title: 'iphone 13 256gb' },
    { id: 'b', title: 'iphone 13 128gb' },
  ])
  expect(result).toEqual(new Set())
})

test('flags all listings that share a title when three or more repeat it', () => {
  const result = computeRepostIds([
    { id: 'a', title: 'RTX 3060' },
    { id: 'b', title: 'RTX 3060' },
    { id: 'c', title: 'RTX 3060' },
  ])
  expect(result).toEqual(new Set(['a', 'b', 'c']))
})

test('returns an empty set for an empty or single-listing list', () => {
  expect(computeRepostIds([])).toEqual(new Set())
  expect(computeRepostIds([{ id: 'a', title: 'RTX 3060' }])).toEqual(new Set())
})
