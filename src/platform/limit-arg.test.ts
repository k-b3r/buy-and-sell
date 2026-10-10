import { expect, test } from 'vitest'
import { parseLimitArg } from './limit-arg'

test('parseLimitArg returns undefined when no limit was given', () => {
  expect(parseLimitArg(undefined)).toBeUndefined()
})

test('parseLimitArg returns the number for a positive whole number', () => {
  expect(parseLimitArg('50')).toBe(50)
})

test.each(['abc', '0', '-3', '1.5', ''])('parseLimitArg rejects %j', (raw) => {
  expect(() => parseLimitArg(raw)).toThrow('invalid limit argument')
})
