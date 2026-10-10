import { expect, test } from 'vitest'
import { parseLimit, readLimitArg } from './limit-arg'

test('readLimitArg returns the first argument', () => {
  expect(readLimitArg(['50', '--headed'])).toBe('50')
})

test('readLimitArg returns undefined when there are no arguments', () => {
  expect(readLimitArg([])).toBeUndefined()
})

test('parseLimit converts a numeric string to a number', () => {
  expect(parseLimit('50')).toBe(50)
})
