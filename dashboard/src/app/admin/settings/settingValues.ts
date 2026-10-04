import type { SettingMeta, SettingRow, SettingsCategory } from './settingsTypes'

// Storage/API stays in ms (that's what's in Postgres and what workers
// read) - only the input display converts to seconds, since nobody thinks
// in "300000ms" for a 5-minute loop delay. Every ms-unit field's value and
// floor is an exact multiple of 1000 (checked against SETTING_DEFAULTS), so
// this round-trips with no fractional seconds anywhere.
const MS_PER_SECOND = 1000

export function toDisplayValue(field: SettingMeta, rawValue: number): number {
  return field.unit === 'ms' ? rawValue / MS_PER_SECOND : rawValue
}

export function fromDisplayValue(field: SettingMeta, displayValue: number): number {
  return field.unit === 'ms' ? displayValue * MS_PER_SECOND : displayValue
}

export function displayUnitLabel(unit: SettingMeta['unit']): string {
  return unit === 'ms' ? 's' : unit
}

export function initialSettingValues(categories: SettingsCategory[], rows: SettingRow[]): Record<string, number> {
  const values: Record<string, number> = {}
  for (const category of categories) {
    for (const subgroup of category.subgroups) {
      for (const field of subgroup.fields) values[field.key] = field.defaultValue
    }
  }
  for (const row of rows) values[row.key] = row.value
  return values
}
