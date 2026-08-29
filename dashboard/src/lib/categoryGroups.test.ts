import { expect, test } from 'vitest'
import { CATEGORY_GROUPS, groupByMainCategory } from './categoryGroups'

test('CATEGORY_GROUPS accounts for every PRODUCT_CATEGORIES value exactly once', async () => {
  const { PRODUCT_CATEGORIES } = await import('./queries')
  const subs = CATEGORY_GROUPS.flatMap((g) => g.subs)
  expect(subs.sort()).toEqual([...PRODUCT_CATEGORIES].sort())
  expect(new Set(subs).size).toBe(subs.length)
})

test('groupByMainCategory groups items under their main category, preserving CATEGORY_GROUPS order', () => {
  const items = [
    { category: 'Audio', n: 1 },
    { category: 'Phones & Tablets', n: 2 },
    { category: 'Gaming', n: 3 },
  ]

  const result = groupByMainCategory(items, (i) => i.category)

  expect(result).toEqual([
    { main: 'Phones & Computing', items: [{ category: 'Phones & Tablets', n: 2 }] },
    { main: 'Home Electronics & Gaming', items: [{ category: 'Audio', n: 1 }, { category: 'Gaming', n: 3 }] },
  ])
})

test('groupByMainCategory omits main categories with no items', () => {
  const result = groupByMainCategory([{ category: 'Vehicles' }], (i) => i.category)
  expect(result).toEqual([{ main: 'Vehicles', items: [{ category: 'Vehicles' }] }])
})

test('groupByMainCategory keeps multiple items under the same sub in encounter order', () => {
  const items = [
    { category: 'Fashion', n: 1 },
    { category: 'Fitness & Outdoor', n: 2 },
    { category: 'Fashion', n: 3 },
  ]
  const result = groupByMainCategory(items, (i) => i.category)
  expect(result).toEqual([
    {
      main: 'Fashion & Lifestyle',
      items: [
        { category: 'Fashion', n: 1 },
        { category: 'Fitness & Outdoor', n: 2 },
        { category: 'Fashion', n: 3 },
      ],
    },
  ])
})
