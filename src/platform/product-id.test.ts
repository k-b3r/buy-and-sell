import { productIdParamSchema } from './product-id'
import { positiveIntIdSchema } from './positive-int-id'

test('productIdParamSchema is the shared positive-integer id schema', () => {
  expect(productIdParamSchema).toBe(positiveIntIdSchema)
})

test('productIdParamSchema accepts a positive integer string and returns a number', () => {
  expect(productIdParamSchema.parse('42')).toBe(42)
})

test.each(['0', '-1', '1.5', 'abc', '', '007', '1e3'])('productIdParamSchema rejects %j', (raw) => {
  expect(productIdParamSchema.safeParse(raw).success).toBe(false)
})
