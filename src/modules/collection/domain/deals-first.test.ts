import { putDealsFirst } from './deals-first'

test('putDealsFirst puts deal candidates ahead of the backlog, drops duplicates and caps at the limit', () => {
  const c = (id: string) => ({ id, flagged_removed_at: null, source_photo_ids: null })

  const merged = putDealsFirst([c('d1'), c('d2')], [c('a'), c('d1'), c('b'), c('d3')], 4)

  expect(merged.map((x) => x.id)).toEqual(['d1', 'd2', 'a', 'b'])
})
