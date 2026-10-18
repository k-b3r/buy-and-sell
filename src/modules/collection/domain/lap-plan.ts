import type { LapPlanInput, LapQuery } from '../types'

export function planLapQueries(input: LapPlanInput): LapQuery[] {
  const plan: LapQuery[] = input.general.map((query) => ({ query, maxItems: input.defaultMaxItems }))
  const due =
    input.reEnabled >= 1 && input.realEstate.length > 0 && (input.lap - 1) % Math.max(1, input.reEveryNLaps) === 0
  if (due) plan.push(...input.realEstate.map((query) => ({ query, maxItems: input.reMaxItems })))
  return plan
}
