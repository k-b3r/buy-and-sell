import { expect, test } from 'vitest'
import { parseProductId } from './productId'

test('parseProductId returns the number for a positive integer segment', () => {
  expect(parseProductId('42')).toBe(42)
})

test.each(['abc', '0', '-3', '1.5', '', 'NaN'])('parseProductId returns null for %j', (raw) => {
  expect(parseProductId(raw)).toBeNull()
})
