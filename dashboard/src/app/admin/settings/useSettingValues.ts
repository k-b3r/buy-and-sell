import { useEffect, useState } from 'react'
import { SETTINGS_CATEGORIES } from './settingsCatalog'
import { fromDisplayValue, initialSettingValues } from './settingValues'
import type { SaveState, SettingMeta, SettingRow, SettingsSubgroup } from './settingsTypes'

// The numeric knobs behind /api/settings: loads them once, edits them in
// display units, and saves one subgroup at a time (the route's pacing-pair
// check relies on a whole subgroup arriving in one PATCH).
export function useSettingValues() {
  const [values, setValues] = useState<Record<string, number>>({})
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({})
  const [saveError, setSaveError] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/settings')
        const body = (await res.json()) as { settings?: SettingRow[]; error?: string }
        if (cancelled) return
        if (!res.ok) {
          setLoadError(body.error ?? 'Failed to load settings')
          return
        }
        setValues(initialSettingValues(SETTINGS_CATEGORIES, body.settings ?? []))
        setLoaded(true)
      } catch {
        if (!cancelled) setLoadError('Could not reach the settings API')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  function handleChange(field: SettingMeta, raw: string) {
    const parsedDisplay = Number(raw)
    if (!Number.isFinite(parsedDisplay)) return
    setValues((prev) => ({ ...prev, [field.key]: fromDisplayValue(field, parsedDisplay) }))
  }

  async function handleSave(subgroup: SettingsSubgroup) {
    setSaveState((prev) => ({ ...prev, [subgroup.id]: 'saving' }))
    setSaveError((prev) => ({ ...prev, [subgroup.id]: '' }))
    try {
      const updates = subgroup.fields.map((field) => ({ key: field.key, value: values[field.key] }))
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updates }),
      })
      const body = await res.json()
      if (!res.ok) {
        setSaveState((prev) => ({ ...prev, [subgroup.id]: 'error' }))
        setSaveError((prev) => ({ ...prev, [subgroup.id]: body.error ?? 'Save failed' }))
        return
      }
      setSaveState((prev) => ({ ...prev, [subgroup.id]: 'saved' }))
      setTimeout(
        () => setSaveState((prev) => (prev[subgroup.id] === 'saved' ? { ...prev, [subgroup.id]: 'idle' } : prev)),
        2000,
      )
    } catch {
      setSaveState((prev) => ({ ...prev, [subgroup.id]: 'error' }))
      setSaveError((prev) => ({ ...prev, [subgroup.id]: 'Could not reach the settings API' }))
    }
  }

  return { values, loaded, loadError, saveState, saveError, handleChange, handleSave }
}
