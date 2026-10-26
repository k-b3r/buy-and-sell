import { REAL_ESTATE_PAGE_SIZE } from './domain/filters'
import { realEstateQuerySchema } from './schemas'

function parse(input: unknown) {
  const result = realEstateQuerySchema.safeParse(input)
  if (!result.success) throw new Error('expected the query to parse')
  return result.data
}

test('realEstateQuerySchema defaults to the first page with no filters', () => {
  expect(parse({})).toEqual({ filters: { limit: REAL_ESTATE_PAGE_SIZE, offset: 0 }, page: 1 })
})

test('realEstateQuerySchema maps every URL param to its filter field', () => {
  const { filters, page } = parse({
    kind: 'rent',
    type: 'condo',
    area: ' Pasig ',
    project: 'Portico',
    min: '1000',
    max: '50000',
    sqm: '25',
    sort: 'price_asc',
    view: 'review',
    rooms: '1',
    page: '3',
  })

  expect(page).toBe(3)
  expect(filters).toEqual({
    limit: REAL_ESTATE_PAGE_SIZE,
    offset: 2 * REAL_ESTATE_PAGE_SIZE,
    listingType: 'rent',
    propertyType: 'condo',
    area: 'Pasig',
    project: 'Portico',
    minPrice: 1000,
    maxPrice: 50000,
    minSqm: 25,
    sort: 'price_asc',
    view: 'review',
    includeRoomShares: true,
  })
})

test('realEstateQuerySchema ignores values the page never honoured instead of failing', () => {
  const { filters, page } = parse({
    kind: 'swap',
    type: 'spaceship',
    area: '   ',
    min: 'abc',
    max: '-5',
    sqm: '',
    sort: 'random',
    view: 'other',
    rooms: '0',
    page: '0',
  })

  expect(page).toBe(1)
  expect(filters).toEqual({ limit: REAL_ESTATE_PAGE_SIZE, offset: 0 })
})

test('realEstateQuerySchema rejects a repeated param, which arrives as an array', () => {
  const result = realEstateQuerySchema.safeParse({ kind: ['sale', 'rent'] })

  expect(result.success).toBe(false)
})
