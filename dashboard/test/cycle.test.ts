import { expect, test } from 'vitest'
import { getActiveListingId, getCycleTarget } from '../src/app/listings/[id]/cycle'

test('getActiveListingId extracts the id from a masked /listings/<id> pathname', () => {
  expect(getActiveListingId('/listings/100000000000004')).toBe('100000000000004')
})

test('getActiveListingId returns null for unrelated pathnames', () => {
  expect(getActiveListingId('/products/5')).toBeNull()
  expect(getActiveListingId('/')).toBeNull()
  expect(getActiveListingId(null)).toBeNull()
})

test('getCycleTarget returns neighbors on either side of the current id', () => {
  expect(getCycleTarget(['a', 'b', 'c'], 'b')).toEqual({ prevId: 'a', nextId: 'c' })
})

test('getCycleTarget wraps around at both ends', () => {
  expect(getCycleTarget(['a', 'b', 'c'], 'a')).toEqual({ prevId: 'c', nextId: 'b' })
  expect(getCycleTarget(['a', 'b', 'c'], 'c')).toEqual({ prevId: 'b', nextId: 'a' })
})

test('getCycleTarget returns nulls when currentId is not in the list', () => {
  expect(getCycleTarget(['a', 'b', 'c'], 'z')).toEqual({ prevId: null, nextId: null })
})

test('getCycleTarget returns nulls for an empty list', () => {
  expect(getCycleTarget([], 'a')).toEqual({ prevId: null, nextId: null })
})

test('getCycleTarget returns nulls when there is only one listing', () => {
  expect(getCycleTarget(['a'], 'a')).toEqual({ prevId: null, nextId: null })
})
