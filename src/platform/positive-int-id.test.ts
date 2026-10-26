import { positiveIntIdSchema } from './positive-int-id'

test('positiveIntIdSchema turns a positive integer string into a number', () => {
  expect(positiveIntIdSchema.parse('42')).toBe(42)
  expect(positiveIntIdSchema.parse('7')).toBe(7)
})

test.each(['0', '-1', '1.5', 'abc', '', '007', '1e3', ' 1', '1 '])('positiveIntIdSchema rejects %j', (raw) => {
  expect(positiveIntIdSchema.safeParse(raw).success).toBe(false)
})

test('positiveIntIdSchema keeps the 400 body the id routes have always sent', () => {
  const result = positiveIntIdSchema.safeParse('0')

  expect(result.error?.issues[0].message).toBe('id must be a positive integer')
})
