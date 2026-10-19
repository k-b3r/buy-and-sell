import { planLapQueries } from './lap-plan'

const lapBase = {
  general: ['rush sale', 'preloved'],
  realEstate: ['house and lot'],
  reEveryNLaps: 3,
  reMaxItems: 50,
  defaultMaxItems: 100,
}

test('planLapQueries returns only general keywords, unchanged, while the real estate flag is off', () => {
  const plan = planLapQueries({ ...lapBase, lap: 1, reEnabled: 0 })
  expect(plan).toEqual([
    { query: 'rush sale', maxItems: 100 },
    { query: 'preloved', maxItems: 100 },
  ])
})

test('planLapQueries appends the real estate pass on lap 1 and every Nth lap, capped by reMaxItems', () => {
  expect(planLapQueries({ ...lapBase, lap: 1, reEnabled: 1 }).at(-1)).toEqual({ query: 'house and lot', maxItems: 50 })
  expect(planLapQueries({ ...lapBase, lap: 2, reEnabled: 1 })).toHaveLength(2)
  expect(planLapQueries({ ...lapBase, lap: 3, reEnabled: 1 })).toHaveLength(2)
  expect(planLapQueries({ ...lapBase, lap: 4, reEnabled: 1 })).toHaveLength(3)
})

test('planLapQueries keeps general keywords first so their order never changes', () => {
  const plan = planLapQueries({ ...lapBase, lap: 1, reEnabled: 1 })
  expect(plan.slice(0, 2).map((p) => p.query)).toEqual(['rush sale', 'preloved'])
})
