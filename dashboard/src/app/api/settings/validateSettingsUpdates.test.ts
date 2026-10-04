import { expect, test } from 'vitest'
import { validateSettingsUpdates } from './validateSettingsUpdates'

test('validateSettingsUpdates accepts known keys at or above their floor', () => {
  expect(
    validateSettingsUpdates([
      { key: 'collect.max_items_default', value: 1 },
      { key: 'collect.loop_delay_ms', value: 10000 },
    ]),
  ).toEqual({
    updates: [
      { key: 'collect.max_items_default', value: 1 },
      { key: 'collect.loop_delay_ms', value: 10000 },
    ],
  })
})

test('validateSettingsUpdates rejects a missing or empty updates array', () => {
  expect(validateSettingsUpdates(undefined)).toEqual({ error: 'updates must be a non-empty array' })
  expect(validateSettingsUpdates([])).toEqual({ error: 'updates must be a non-empty array' })
})

test('validateSettingsUpdates rejects a non-integer or non-numeric value', () => {
  expect(validateSettingsUpdates([{ key: 'collect.max_items_default', value: 1.5 }])).toEqual({
    error: 'invalid update: {"key":"collect.max_items_default","value":1.5}',
  })
  expect(validateSettingsUpdates([{ key: 'collect.max_items_default', value: '5' }])).toEqual({
    error: 'invalid update: {"key":"collect.max_items_default","value":"5"}',
  })
  expect(validateSettingsUpdates([null])).toEqual({ error: 'invalid update: null' })
})

test('validateSettingsUpdates rejects an unknown setting key', () => {
  expect(validateSettingsUpdates([{ key: 'nope', value: 1 }])).toEqual({ error: 'unknown setting key "nope"' })
})

test('validateSettingsUpdates rejects a value below the key floor', () => {
  expect(validateSettingsUpdates([{ key: 'collect.pacing_min_ms', value: 1999 }])).toEqual({
    error: 'collect.pacing_min_ms must be >= 2000',
  })
})

test('validateSettingsUpdates rejects a percent key above 100', () => {
  expect(validateSettingsUpdates([{ key: 'discount_policy.high_discount_threshold_percent', value: 101 }])).toEqual({
    error: 'discount_policy.high_discount_threshold_percent must be <= 100',
  })
})

test('validateSettingsUpdates rejects a pacing min above its max when both are submitted', () => {
  expect(
    validateSettingsUpdates([
      { key: 'collect.pacing_min_ms', value: 5000 },
      { key: 'collect.pacing_max_ms', value: 4000 },
    ]),
  ).toEqual({ error: 'collect.pacing_min_ms must be <= collect.pacing_max_ms' })
})

test('validateSettingsUpdates skips the pacing check when only one member of a pair is submitted', () => {
  expect(validateSettingsUpdates([{ key: 'collect.pacing_min_ms', value: 50000 }])).toEqual({
    updates: [{ key: 'collect.pacing_min_ms', value: 50000 }],
  })
})
