export interface SettingMeta {
  key: string
  label: string
  description: string
  unit: 'ms' | 'count' | 'percent' | 'pesos'
  min: number
  max?: number
  defaultValue: number
}

export interface SettingsSubgroup {
  id: string
  title: string
  fields: SettingMeta[]
}

export interface SettingsCategory {
  id: string
  label: string
  subgroups: SettingsSubgroup[]
}

export interface SettingRow {
  key: string
  value: number
  updatedAt: string
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'
