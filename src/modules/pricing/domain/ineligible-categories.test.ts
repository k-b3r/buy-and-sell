import { PRICE_INELIGIBLE_CATEGORIES } from './ineligible-categories'

test('the curated list has entries for every reason it names', () => {
  for (const [reason, baseModels] of Object.entries(PRICE_INELIGIBLE_CATEGORIES)) {
    expect([reason, baseModels.length > 0]).toEqual([reason, true])
  }
})

test('no base_model is curated under two exclusion reasons', () => {
  const all = Object.values(PRICE_INELIGIBLE_CATEGORIES).flat()

  expect(all.filter((name, i) => all.indexOf(name) !== i)).toEqual([])
})
