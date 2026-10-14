import { listingsQuerySchema, productIdParamSchema, productListQuerySchema } from './schemas'

test('productIdParamSchema accepts a positive integer string and returns a number', () => {
  expect(productIdParamSchema.parse('42')).toBe(42)
})

test.each(['0', '-1', '1.5', 'abc', '', '007', '1e3'])('productIdParamSchema rejects %j', (raw) => {
  expect(productIdParamSchema.safeParse(raw).success).toBe(false)
})

test('productListQuerySchema defaults to no search, no filters and offset 0', () => {
  expect(productListQuerySchema.parse({})).toEqual({ search: undefined, categories: [], subCategories: [], offset: 0 })
})

test('productListQuerySchema reads q, repeated category params, a single subCategory and offset', () => {
  const parsed = productListQuerySchema.parse({
    q: 'iphone',
    category: ['Phones', 'Laptops'],
    subCategory: 'Mac',
    offset: '30',
  })

  expect(parsed).toEqual({ search: 'iphone', categories: ['Phones', 'Laptops'], subCategories: ['Mac'], offset: 30 })
})

test.each(['-1', '1.5', 'abc', ''])('productListQuerySchema rejects offset %j', (offset) => {
  expect(productListQuerySchema.safeParse({ offset }).success).toBe(false)
})

test('listingsQuerySchema falls back to the default filters when params are absent or unknown', () => {
  const defaults = {
    sortKey: 'discount_desc',
    listedWithinDays: 0,
    hideSold: true,
    negotiableOnly: false,
    selectedBand: null,
  }

  expect(listingsQuerySchema.parse({}).filters).toEqual(defaults)
  expect(listingsQuerySchema.parse({ sort: 'nope', listedWithin: '5', band: 'x' }).filters).toEqual(defaults)
})

test('listingsQuerySchema reads sort, listedWithin, hideSold, negotiable, band and offset', () => {
  const parsed = listingsQuerySchema.parse({
    sort: 'price_asc',
    listedWithin: '30',
    hideSold: '0',
    negotiable: '1',
    band: '20',
    offset: '60',
  })

  expect(parsed).toEqual({
    filters: { sortKey: 'price_asc', listedWithinDays: 30, hideSold: false, negotiableOnly: true, selectedBand: 20 },
    offset: 60,
  })
})

test('listingsQuerySchema keeps hideSold only for "1" when the param is present, like the old Next handler', () => {
  expect(listingsQuerySchema.parse({ hideSold: '1' }).filters.hideSold).toBe(true)
  expect(listingsQuerySchema.parse({ hideSold: 'maybe' }).filters.hideSold).toBe(false)
})

test('listingsQuerySchema rejects a bad offset', () => {
  expect(listingsQuerySchema.safeParse({ offset: '-5' }).success).toBe(false)
})
