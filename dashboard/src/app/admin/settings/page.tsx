'use client'

import { useState } from 'react'
import CollectKeywordsSection from './CollectKeywordsSection'
import SettingsGroupSection from './SettingsGroupSection'
import TabButton from './TabButton'
import { SETTINGS_CATEGORIES } from './settingsCatalog'
import type { SettingsCategory } from './settingsTypes'
import { useCollectKeywords } from './useCollectKeywords'
import { useSettingValues } from './useSettingValues'

export default function SettingsPage() {
  const { values, loaded, loadError, saveState, saveError, handleChange, handleSave } = useSettingValues()
  const keywordsEditor = useCollectKeywords()
  const [activeCategoryId, setActiveCategoryId] = useState(SETTINGS_CATEGORIES[0].id)
  const [activeSubgroupId, setActiveSubgroupId] = useState(SETTINGS_CATEGORIES[0].subgroups[0].id)

  const activeCategory = SETTINGS_CATEGORIES.find((c) => c.id === activeCategoryId) ?? SETTINGS_CATEGORIES[0]
  const activeSubgroup = activeCategory.subgroups.find((s) => s.id === activeSubgroupId) ?? activeCategory.subgroups[0]

  function handleSelectCategory(category: SettingsCategory) {
    setActiveCategoryId(category.id)
    setActiveSubgroupId(category.subgroups[0].id)
  }

  if (loadError) {
    return (
      <div>
        <h1>Settings</h1>
        <p style={{ color: 'var(--color-danger)' }}>{loadError}</p>
      </div>
    )
  }

  if (!loaded) {
    return (
      <div>
        <h1>Settings</h1>
        <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>
      </div>
    )
  }

  return (
    <div>
      <h1>Settings</h1>
      <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginBottom: 20 }}>
        Worker cadence/batch/pacing/retry knobs and discount-policy thresholds. Workers pick up a change on their next
        lap — no restart needed.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {SETTINGS_CATEGORIES.map((category) => (
          <TabButton
            key={category.id}
            label={category.label}
            selected={category.id === activeCategoryId}
            onClick={() => handleSelectCategory(category)}
          />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {activeCategory.subgroups.map((subgroup) => (
          <TabButton
            key={subgroup.id}
            label={subgroup.title}
            selected={subgroup.id === activeSubgroupId}
            onClick={() => setActiveSubgroupId(subgroup.id)}
          />
        ))}
      </div>

      <SettingsGroupSection
        subgroup={activeSubgroup}
        values={values}
        saveState={saveState[activeSubgroup.id] ?? 'idle'}
        saveError={saveError[activeSubgroup.id]}
        onChange={handleChange}
        onSave={() => handleSave(activeSubgroup)}
      />

      {activeSubgroup.id === 'collect' && <CollectKeywordsSection editor={keywordsEditor} />}
    </div>
  )
}
