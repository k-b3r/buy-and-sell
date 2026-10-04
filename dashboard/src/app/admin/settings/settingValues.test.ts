import { expect, test } from 'vitest'
import { displayUnitLabel, fromDisplayValue, initialSettingValues, toDisplayValue } from './settingValues'
import type { SettingMeta, SettingsCategory } from './settingsTypes'

const MS_FIELD: SettingMeta = {
  key: 'a.loop_delay_ms',
  label: 'Loop delay',
  description: '',
  unit: 'ms',
  min: 1000,
  defaultValue: 5000,
}
const COUNT_FIELD: SettingMeta = {
  key: 'a.batch_size',
  label: 'Batch size',
  description: '',
  unit: 'count',
  min: 1,
  defaultValue: 10,
}
const CATEGORIES: SettingsCategory[] = [
  { id: 'c', label: 'C', subgroups: [{ id: 'a', title: 'a', fields: [MS_FIELD, COUNT_FIELD] }] },
]

test('toDisplayValue shows ms fields in seconds and leaves other units as-is', () => {
  expect(toDisplayValue(MS_FIELD, 300000)).toBe(300)
  expect(toDisplayValue(COUNT_FIELD, 25)).toBe(25)
})

test('fromDisplayValue converts a seconds input back to ms for ms fields only', () => {
  expect(fromDisplayValue(MS_FIELD, 300)).toBe(300000)
  expect(fromDisplayValue(COUNT_FIELD, 25)).toBe(25)
})

test('displayUnitLabel shows ms as s and other units by name', () => {
  expect(displayUnitLabel('ms')).toBe('s')
  expect(displayUnitLabel('pesos')).toBe('pesos')
})

test('initialSettingValues uses stored rows over catalog defaults', () => {
  expect(initialSettingValues(CATEGORIES, [{ key: 'a.batch_size', value: 7, updatedAt: '2026-01-01' }])).toEqual({
    'a.loop_delay_ms': 5000,
    'a.batch_size': 7,
  })
})

test('initialSettingValues keeps a stored row whose key is not in the catalog', () => {
  expect(initialSettingValues(CATEGORIES, [{ key: 'other', value: 1, updatedAt: '2026-01-01' }])).toEqual({
    'a.loop_delay_ms': 5000,
    'a.batch_size': 10,
    other: 1,
  })
})
