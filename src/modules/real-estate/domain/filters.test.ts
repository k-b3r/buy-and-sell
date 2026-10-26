import { REAL_ESTATE_PAGE_SIZE, REAL_ESTATE_PROPERTY_TYPES, REAL_ESTATE_SORTS } from './filters'

test('the real-estate filter constants keep the values the API and the dashboard already use', () => {
  expect(REAL_ESTATE_PAGE_SIZE).toBe(30)
  expect(REAL_ESTATE_PROPERTY_TYPES).toEqual(['house_and_lot', 'condo', 'land', 'commercial', 'other'])
  expect(REAL_ESTATE_SORTS).toEqual(['newest', 'price_asc', 'price_desc', 'ppsqm_asc'])
})
