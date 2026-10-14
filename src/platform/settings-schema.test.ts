import { SETTING_DEFAULTS } from './settings'
import { SETTING_FLOORS, settingsUpdatesSchema } from './settings-schema'

function parse(updates: unknown) {
  return settingsUpdatesSchema.safeParse(updates)
}

function errorOf(updates: unknown): string | undefined {
  const result = parse(updates)
  return result.success ? undefined : result.error.issues[0].message
}

test('every setting with a default has a floor, so no key can be saved unvalidated', () => {
  expect(Object.keys(SETTING_FLOORS).sort()).toEqual(Object.keys(SETTING_DEFAULTS).sort())
})

test('accepts a valid batch of updates and returns it unchanged', () => {
  const updates = [
    { key: 'collect.max_items_default', value: 50 },
    { key: 'check_listings.limit_default', value: 20 },
  ]

  expect(parse(updates)).toEqual({ success: true, data: updates })
})

test('rejects anything that is not a non-empty array', () => {
  expect(errorOf(undefined)).toBe('updates must be a non-empty array')
  expect(errorOf({})).toBe('updates must be a non-empty array')
  expect(errorOf([])).toBe('updates must be a non-empty array')
})

test('rejects an update that is not a key and an integer value', () => {
  expect(errorOf([{ key: 'collect.max_items_default', value: 1.5 }])).toContain('invalid update')
  expect(errorOf([{ key: 'collect.max_items_default', value: '5' }])).toContain('invalid update')
  expect(errorOf([{ key: 7, value: 5 }])).toContain('invalid update')
  expect(errorOf([null])).toContain('invalid update')
})

test('rejects a key that is not a known setting', () => {
  expect(errorOf([{ key: 'made.up_key', value: 5 }])).toBe('unknown setting key "made.up_key"')
})

test('rejects a value below the key floor, naming the key and floor', () => {
  expect(errorOf([{ key: 'collect.max_items_default', value: 0 }])).toBe('collect.max_items_default must be >= 1')
  expect(errorOf([{ key: 'collect.loop_delay_ms', value: 9999 }])).toBe('collect.loop_delay_ms must be >= 10000')
})

test('allows zero for flag settings whose floor is 0', () => {
  expect(parse([{ key: 'llm.gateway_enabled', value: 0 }]).success).toBe(true)
})

test('rejects a percent setting above 100', () => {
  const key = 'discount_policy.high_discount_threshold_percent'

  expect(errorOf([{ key, value: 101 }])).toBe(`${key} must be <= 100`)
  expect(parse([{ key, value: 100 }]).success).toBe(true)
})

test('rejects a pacing pair whose min is above its max when both are submitted', () => {
  const updates = [
    { key: 'collect.pacing_min_ms', value: 9000 },
    { key: 'collect.pacing_max_ms', value: 3000 },
  ]

  expect(errorOf(updates)).toBe('collect.pacing_min_ms must be <= collect.pacing_max_ms')
})

test('allows a pacing min alone, since the other half is not in the batch to compare', () => {
  expect(parse([{ key: 'collect.pacing_min_ms', value: 9000 }]).success).toBe(true)
})
