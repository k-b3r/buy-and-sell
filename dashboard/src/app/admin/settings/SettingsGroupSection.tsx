import InfoTooltip from '../../InfoTooltip'
import SaveControls from './SaveControls'
import { displayUnitLabel, toDisplayValue } from './settingValues'
import type { SaveState, SettingMeta, SettingsSubgroup } from './settingsTypes'

export default function SettingsGroupSection({
  subgroup,
  values,
  saveState,
  saveError,
  onChange,
  onSave,
}: {
  subgroup: SettingsSubgroup
  values: Record<string, number>
  saveState: SaveState
  saveError: string | undefined
  onChange: (field: SettingMeta, raw: string) => void
  onSave: () => void
}) {
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        padding: 16,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {subgroup.fields.map((field) => (
          <label
            key={field.key}
            style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.85em' }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 220 }}>
              {field.label}
              <InfoTooltip text={field.description} style={{ color: 'var(--color-text-muted)' }} />
            </span>
            <input
              type="number"
              min={toDisplayValue(field, field.min)}
              max={field.max !== undefined ? toDisplayValue(field, field.max) : undefined}
              step={1}
              value={toDisplayValue(field, values[field.key] ?? field.defaultValue)}
              onChange={(e) => onChange(field, e.target.value)}
              style={{
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                padding: '4px 8px',
                color: 'var(--color-text)',
                width: 120,
              }}
            />
            <span style={{ color: 'var(--color-text-muted)' }}>{displayUnitLabel(field.unit)}</span>
          </label>
        ))}
      </div>
      <SaveControls state={saveState} error={saveError} onSave={onSave} />
    </div>
  )
}
