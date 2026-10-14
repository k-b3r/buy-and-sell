import { beforeEach, expect, test, vi } from 'vitest'

const revalidateTag = vi.fn()
vi.mock('next/cache', () => ({ revalidateTag }))

const { revalidateProduct } = await import('./revalidateProduct')

beforeEach(() => revalidateTag.mockClear())

test('revalidateProduct expires the product detail and product list cache tags immediately', async () => {
  await revalidateProduct(42)

  expect(revalidateTag).toHaveBeenCalledWith('product:42', { expire: 0 })
  expect(revalidateTag).toHaveBeenCalledWith('products-list', { expire: 0 })
})

test('revalidateProduct ignores an id that is not a positive integer', async () => {
  for (const id of [0, -1, 1.5, Number.NaN]) await revalidateProduct(id)

  expect(revalidateTag).not.toHaveBeenCalled()
})
