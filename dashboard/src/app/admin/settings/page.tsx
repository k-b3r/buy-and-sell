'use client'

import { useEffect, useState } from 'react'
import InfoTooltip from '../../InfoTooltip'

interface SettingMeta {
  key: string
  label: string
  description: string
  unit: 'ms' | 'count' | 'percent' | 'pesos'
  min: number
  max?: number
  defaultValue: number
}

interface SettingsSubgroup {
  id: string
  title: string
  fields: SettingMeta[]
}

interface SettingsCategory {
  id: string
  label: string
  subgroups: SettingsSubgroup[]
}

// Mirrors src/platform/settings.ts's SETTING_DEFAULTS key list - kept in
// sync by hand, same precedent as admin/logs' WORKER_DESCRIPTIONS
// (dashboard/ and the worker scripts are separate packages with no shared
// import path). defaultValue is only a display fallback for a key that
// hasn't been migrated into the settings table yet - the real fallback
// used by the workers themselves lives in SETTING_DEFAULTS.
//
// Two categories today (Workers, Listings) - per direct instruction, more
// main-nav categories (Products, ...) land here as their own settings show
// up. Discount Policy sits under Listings, not Workers, since it's a
// cross-cutting business-rule threshold, not any one worker's cadence knob.
const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'workers',
    label: 'Workers',
    subgroups: [
      {
        id: 'collect',
        title: 'collect',
        fields: [
          {
            key: 'collect.max_items_default',
            label: 'Max items per query',
            description: 'Default per-query item cap when no CLI arg is given.',
            unit: 'count',
            min: 1,
            defaultValue: 100,
          },
          {
            key: 'collect.soft_wall_timeout_ms',
            label: 'Soft-wall retry wait',
            description: 'How long to wait before retrying after a Facebook soft login-wall.',
            unit: 'ms',
            min: 1000,
            defaultValue: 5000,
          },
          {
            key: 'collect.pacing_min_ms',
            label: 'Pacing min (per listing)',
            description: 'Minimum random pause between opening listings during a live Facebook run.',
            unit: 'ms',
            min: 2000,
            defaultValue: 4000,
          },
          {
            key: 'collect.pacing_max_ms',
            label: 'Pacing max (per listing)',
            description: 'Maximum random pause between opening listings during a live Facebook run.',
            unit: 'ms',
            min: 2000,
            defaultValue: 10000,
          },
          {
            key: 'collect.loop_delay_ms',
            label: 'Loop delay',
            description: 'Pause between laps (a full pass through the keyword list) in --cycle mode. Also how long the browser stays closed between laps, freeing it for check-listings to use.',
            unit: 'ms',
            min: 10000,
            defaultValue: 300000,
          },
          {
            key: 'collect.re_keywords_enabled',
            label: 'Real estate keywords',
            description: '1 = also run the real estate keyword pass; 0 = general keywords only (default).',
            unit: 'count',
            min: 0,
            defaultValue: 0,
          },
          {
            key: 'collect.re_every_n_laps',
            label: 'Real estate pass every N laps',
            description: 'The real estate keyword pass runs on lap 1 and every Nth lap after it.',
            unit: 'count',
            min: 1,
            defaultValue: 3,
          },
          {
            key: 'collect.re_max_items',
            label: 'Max items per real estate query',
            description: 'Per-query item cap during the real estate pass.',
            unit: 'count',
            min: 1,
            defaultValue: 50,
          },
        ],
      },
      {
        id: 'check_listings',
        title: 'check-listings',
        fields: [
          {
            key: 'check_listings.loop_delay_ms',
            label: 'Loop delay',
            description: 'Pause between laps.',
            unit: 'ms',
            min: 10000,
            defaultValue: 60000,
          },
          {
            key: 'check_listings.limit_default',
            label: 'Listings per lap',
            description: 'Default number of listings checked per lap when no CLI arg is given.',
            unit: 'count',
            min: 1,
            defaultValue: 100,
          },
          {
            key: 'check_listings.soft_wall_timeout_ms',
            label: 'Soft-wall retry wait',
            description:
              'How long to wait before retrying after a Facebook soft login-wall. Also used by the dashboard’s on-demand Refresh buttons.',
            unit: 'ms',
            min: 1000,
            defaultValue: 5000,
          },
          {
            key: 'check_listings.pacing_min_ms',
            label: 'Pacing min (per listing)',
            description: 'Minimum random pause between checking listings during a live Facebook run.',
            unit: 'ms',
            min: 2000,
            defaultValue: 2000,
          },
          {
            key: 'check_listings.pacing_max_ms',
            label: 'Pacing max (per listing)',
            description: 'Maximum random pause between checking listings during a live Facebook run.',
            unit: 'ms',
            min: 2000,
            defaultValue: 4000,
          },
          {
            key: 'check_listings.re_recheck_min_days',
            label: 'Real estate recheck spacing',
            description: 'Skip real estate listings checked within this many days. 0 = no skipping (default). Other categories are unaffected.',
            unit: 'count',
            min: 0,
            defaultValue: 0,
          },
        ],
      },
      {
        id: 'extract_products',
        title: 'extract-products',
        fields: [
          {
            key: 'extract_products.max_attempts',
            label: 'Max attempts',
            description: 'Retry attempts per LLM provider before falling through/failing the batch.',
            unit: 'count',
            min: 1,
            defaultValue: 5,
          },
          {
            key: 'extract_products.retry_base_delay_ms',
            label: 'Retry base delay',
            description: 'Base delay for exponential backoff between retries.',
            unit: 'ms',
            min: 1000,
            defaultValue: 30000,
          },
          {
            key: 'extract_products.loop_delay_ms',
            label: 'Loop delay',
            description: 'Pause between laps.',
            unit: 'ms',
            min: 1000,
            defaultValue: 300000,
          },
          {
            key: 'extract_products.batch_size',
            label: 'Batch size',
            description: 'Listings sent to the LLM per extraction request.',
            unit: 'count',
            min: 1,
            defaultValue: 100,
          },
          {
            key: 'extract_products.inter_batch_delay_ms',
            label: 'Inter-batch delay',
            description: 'Pause between batches within a lap.',
            unit: 'ms',
            min: 1000,
            defaultValue: 5000,
          },
        ],
      },
      {
        id: 'enrich_products',
        title: 'enrich-products',
        fields: [
          {
            key: 'enrich_products.batch_size',
            label: 'Batch size',
            description: 'Products sent to the LLM per enrichment request.',
            unit: 'count',
            min: 1,
            defaultValue: 20,
          },
          {
            key: 'enrich_products.loop_delay_ms',
            label: 'Loop delay',
            description: 'Pause between laps.',
            unit: 'ms',
            min: 1000,
            defaultValue: 300000,
          },
          {
            key: 'enrich_products.max_attempts',
            label: 'Max attempts',
            description: 'Retry attempts on a malformed/failed batch response.',
            unit: 'count',
            min: 1,
            defaultValue: 3,
          },
          {
            key: 'enrich_products.retry_delay_ms',
            label: 'Retry delay',
            description: 'Fixed delay between retries.',
            unit: 'ms',
            min: 1000,
            defaultValue: 3000,
          },
        ],
      },
      {
        id: 'price_lookup',
        title: 'price-lookup',
        fields: [
          {
            key: 'price_lookup.lap_limit_default',
            label: 'Products per lap',
            description: 'Default number of products priced per lap when no CLI arg is given.',
            unit: 'count',
            min: 1,
            defaultValue: 20,
          },
          {
            key: 'price_lookup.loop_delay_ms',
            label: 'Loop delay',
            description: 'Pause between laps.',
            unit: 'ms',
            min: 1000,
            defaultValue: 300000,
          },
          {
            key: 'price_lookup.pacing_delay_ms',
            label: 'Pacing delay',
            description: 'Pause between products within a lap.',
            unit: 'ms',
            min: 1000,
            defaultValue: 1000,
          },
        ],
      },
      {
        id: 'enrich_listing_prices',
        title: 'enrich-listing-prices',
        fields: [
          {
            key: 'enrich_listing_prices.batch_size',
            label: 'Batch size',
            description: 'Listings sent to the LLM per price-review request.',
            unit: 'count',
            min: 1,
            defaultValue: 35,
          },
          {
            key: 'enrich_listing_prices.loop_delay_ms',
            label: 'Loop delay',
            description: 'Pause between laps.',
            unit: 'ms',
            min: 1000,
            defaultValue: 300000,
          },
        ],
      },
      {
        id: 'extract_real_estate',
        title: 'extract-real-estate',
        fields: [
          {
            key: 'extract_real_estate.batch_size',
            label: 'Batch size',
            description: 'Listings sent to the LLM per extraction request.',
            unit: 'count',
            min: 1,
            defaultValue: 10,
          },
          {
            key: 'extract_real_estate.loop_delay_ms',
            label: 'Loop delay',
            description: 'Pause between laps.',
            unit: 'ms',
            min: 1000,
            defaultValue: 300000,
          },
        ],
      },
      {
        id: 'verify_discount',
        title: 'verify-discount-notifications',
        fields: [
          {
            key: 'verify_discount.lap_limit_default',
            label: 'Paid-API candidates per lap',
            description: 'How many candidates draw against the paid Exa/Tavily/Gemini/OpenRouter budget per lap.',
            unit: 'count',
            min: 1,
            defaultValue: 3,
          },
          {
            key: 'verify_discount.fetch_batch_size',
            label: 'Rows fetched per lap',
            description: 'How many pending rows are pulled per lap (free prechecks run against all of them, uncapped).',
            unit: 'count',
            min: 1,
            defaultValue: 50,
          },
          {
            key: 'verify_discount.loop_delay_ms',
            label: 'Loop delay',
            description: 'Pause between laps.',
            unit: 'ms',
            min: 1000,
            defaultValue: 30000,
          },
          {
            key: 'verify_discount.pacing_delay_ms',
            label: 'Pacing delay',
            description: 'Pause between paid-API candidates within a lap.',
            unit: 'ms',
            min: 1000,
            defaultValue: 1000,
          },
        ],
      },
    ],
  },
  {
    id: 'listings',
    label: 'Listings',
    subgroups: [
      {
        id: 'discount_policy',
        title: 'Discount Policy',
        fields: [
          {
            key: 'discount_policy.high_discount_threshold_percent',
            label: 'High-discount bar',
            description: 'Minimum discount vs. market price for a bell-worthy notification.',
            unit: 'percent',
            min: 0,
            max: 100,
            defaultValue: 30,
          },
          {
            key: 'discount_policy.min_profit_pesos',
            label: 'Minimum profit',
            description: 'Minimum peso gap between asking price and market reference price.',
            unit: 'pesos',
            min: 0,
            defaultValue: 1000,
          },
          {
            key: 'discount_policy.min_price_pesos',
            label: 'Minimum asking price',
            description: 'Below this, a listing is never worth chasing regardless of discount math.',
            unit: 'pesos',
            min: 0,
            defaultValue: 500,
          },
          {
            key: 'discount_policy.gemini_daily_grounding_cap',
            label: 'Gemini grounding daily cap',
            description: 'Client-side cap on Gemini Search-grounded calls per day, to stay under Google’s free allowance.',
            unit: 'count',
            min: 1,
            defaultValue: 1000,
          },
        ],
      },
    ],
  },
]

interface SettingRow {
  key: string
  value: number
  updatedAt: string
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

// Storage/API stays in ms (that's what's in Postgres and what workers
// read) - only the input display converts to seconds, since nobody thinks
// in "300000ms" for a 5-minute loop delay. Every ms-unit field's value and
// floor is an exact multiple of 1000 (checked against SETTING_DEFAULTS), so
// this round-trips with no fractional seconds anywhere.
const MS_PER_SECOND = 1000

function toDisplayValue(field: SettingMeta, rawValue: number): number {
  return field.unit === 'ms' ? rawValue / MS_PER_SECOND : rawValue
}

function fromDisplayValue(field: SettingMeta, displayValue: number): number {
  return field.unit === 'ms' ? displayValue * MS_PER_SECOND : displayValue
}

function displayUnitLabel(unit: SettingMeta['unit']): string {
  return unit === 'ms' ? 's' : unit
}

// Shared look for both tab bars (category and subgroup) - same
// selected/unselected treatment as admin/logs' worker-select buttons.
function TabButton({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: selected ? 'var(--color-accent)' : 'transparent',
        color: selected ? 'var(--color-bg)' : 'var(--color-text)',
        border: `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        borderRadius: 8,
        padding: '4px 10px',
        fontSize: '0.85em',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}

export default function SettingsPage() {
  const [values, setValues] = useState<Record<string, number>>({})
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({})
  const [saveError, setSaveError] = useState<Record<string, string>>({})
  const [activeCategoryId, setActiveCategoryId] = useState(SETTINGS_CATEGORIES[0].id)
  const [activeSubgroupId, setActiveSubgroupId] = useState(SETTINGS_CATEGORIES[0].subgroups[0].id)

  // collect's search-query list - a row editor (add/remove/toggle keywords), not
  // number knobs, hence its own state/endpoint separate from `values`/
  // `/api/settings` above. Only rendered when the collect tab is active.
  const [keywords, setKeywords] = useState<{ keyword: string; enabled: boolean }[]>([])
  const [keywordsLoaded, setKeywordsLoaded] = useState(false)
  const [newKeyword, setNewKeyword] = useState('')
  const [keywordsSaveState, setKeywordsSaveState] = useState<SaveState>('idle')
  const [keywordsSaveError, setKeywordsSaveError] = useState('')

  const activeCategory = SETTINGS_CATEGORIES.find((c) => c.id === activeCategoryId) ?? SETTINGS_CATEGORIES[0]
  const activeSubgroup = activeCategory.subgroups.find((s) => s.id === activeSubgroupId) ?? activeCategory.subgroups[0]

  function handleSelectCategory(category: SettingsCategory) {
    setActiveCategoryId(category.id)
    setActiveSubgroupId(category.subgroups[0].id)
  }

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
        const next: Record<string, number> = {}
        for (const category of SETTINGS_CATEGORIES) {
          for (const subgroup of category.subgroups) {
            for (const field of subgroup.fields) next[field.key] = field.defaultValue
          }
        }
        for (const row of body.settings ?? []) next[row.key] = row.value
        setValues(next)
        setLoaded(true)
      } catch {
        if (!cancelled) setLoadError('Could not reach the settings API')
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function loadKeywords() {
      try {
        const res = await fetch('/api/collect-keywords')
        const body = (await res.json()) as { keywords?: { keyword: string; enabled: boolean }[] }
        if (!cancelled && res.ok) {
          setKeywords(body.keywords ?? [])
          setKeywordsLoaded(true)
        }
      } catch {
        // best-effort - the collect tab just won't show the keyword editor if this fails
      }
    }
    loadKeywords()
    return () => {
      cancelled = true
    }
  }, [])

  function handleAddKeyword() {
    const trimmed = newKeyword.trim().toLowerCase()
    if (trimmed === '' || keywords.some((k) => k.keyword === trimmed)) return
    setKeywords((prev) => [...prev, { keyword: trimmed, enabled: true }])
    setNewKeyword('')
  }

  function handleRemoveKeyword(keyword: string) {
    setKeywords((prev) => prev.filter((k) => k.keyword !== keyword))
  }

  function handleToggleKeyword(keyword: string) {
    setKeywords((prev) => prev.map((k) => (k.keyword === keyword ? { ...k, enabled: !k.enabled } : k)))
  }

  async function handleSaveKeywords() {
    setKeywordsSaveState('saving')
    setKeywordsSaveError('')
    try {
      const res = await fetch('/api/collect-keywords', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keywords }),
      })
      const body = await res.json()
      if (!res.ok) {
        setKeywordsSaveState('error')
        setKeywordsSaveError(body.error ?? 'Save failed')
        return
      }
      setKeywordsSaveState('saved')
      setTimeout(() => setKeywordsSaveState((prev) => (prev === 'saved' ? 'idle' : prev)), 2000)
    } catch {
      setKeywordsSaveState('error')
      setKeywordsSaveError('Could not reach the settings API')
    }
  }

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
      setTimeout(() => setSaveState((prev) => (prev[subgroup.id] === 'saved' ? { ...prev, [subgroup.id]: 'idle' } : prev)), 2000)
    } catch {
      setSaveState((prev) => ({ ...prev, [subgroup.id]: 'error' }))
      setSaveError((prev) => ({ ...prev, [subgroup.id]: 'Could not reach the settings API' }))
    }
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

  const state = saveState[activeSubgroup.id] ?? 'idle'

  return (
    <div>
      <h1>Settings</h1>
      <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginBottom: 20 }}>
        Worker cadence/batch/pacing/retry knobs and discount-policy thresholds. Workers pick up a change on their next lap
        — no restart needed.
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

      <div
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {activeSubgroup.fields.map((field) => (
            <label key={field.key} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.85em' }}>
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
                onChange={(e) => handleChange(field, e.target.value)}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <button
            onClick={() => handleSave(activeSubgroup)}
            disabled={state === 'saving'}
            style={{
              background: 'transparent',
              color: 'var(--color-text)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              padding: '4px 12px',
              fontSize: '0.85em',
              cursor: state === 'saving' ? 'default' : 'pointer',
            }}
          >
            {state === 'saving' ? 'Saving…' : 'Save'}
          </button>
          {state === 'saved' && <span style={{ fontSize: '0.8em', color: 'var(--color-signal)' }}>Saved</span>}
          {state === 'error' && <span style={{ fontSize: '0.8em', color: 'var(--color-danger)' }}>{saveError[activeSubgroup.id]}</span>}
        </div>
      </div>

      {activeSubgroup.id === 'collect' && (
        <div
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            padding: 16,
            marginTop: 16,
          }}
        >
          <h2 className="mono" style={{ fontSize: '1em', marginTop: 0, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            Search keywords
            <InfoTooltip
              text="Motivated-seller phrases the collector searches on --cycle laps (e.g. 'rush sale', 'moving out'). Add or remove as many as you like — collect loops through every enabled one, every lap. Untick to skip a keyword without deleting it."
              style={{ color: 'var(--color-text-muted)' }}
            />
          </h2>
          {!keywordsLoaded ? (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>Loading…</p>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12, marginBottom: 12 }}>
                {keywords.map(({ keyword, enabled }) => (
                  <span
                    key={keyword}
                    style={{
                      opacity: enabled ? 1 : 0.5,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      background: 'var(--color-bg)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 8,
                      padding: '4px 8px',
                      fontSize: '0.85em',
                    }}
                  >
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={enabled} onChange={() => handleToggleKeyword(keyword)} />
                      <span style={{ textDecoration: enabled ? 'none' : 'line-through' }}>{keyword}</span>
                    </label>
                    <button
                      onClick={() => handleRemoveKeyword(keyword)}
                      aria-label={`Remove "${keyword}"`}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--color-text-muted)',
                        cursor: 'pointer',
                        padding: 0,
                        font: 'inherit',
                        lineHeight: 1,
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {keywords.length === 0 && <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>No keywords yet.</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="text"
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleAddKeyword()
                    }
                  }}
                  placeholder="add a keyword…"
                  style={{
                    background: 'var(--color-bg)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 6,
                    padding: '4px 8px',
                    color: 'var(--color-text)',
                    fontSize: '0.85em',
                    width: 200,
                  }}
                />
                <button
                  onClick={handleAddKeyword}
                  style={{
                    background: 'transparent',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 8,
                    padding: '4px 12px',
                    fontSize: '0.85em',
                    cursor: 'pointer',
                  }}
                >
                  Add
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                <button
                  onClick={handleSaveKeywords}
                  disabled={keywordsSaveState === 'saving'}
                  style={{
                    background: 'transparent',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 8,
                    padding: '4px 12px',
                    fontSize: '0.85em',
                    cursor: keywordsSaveState === 'saving' ? 'default' : 'pointer',
                  }}
                >
                  {keywordsSaveState === 'saving' ? 'Saving…' : 'Save'}
                </button>
                {keywordsSaveState === 'saved' && <span style={{ fontSize: '0.8em', color: 'var(--color-signal)' }}>Saved</span>}
                {keywordsSaveState === 'error' && <span style={{ fontSize: '0.8em', color: 'var(--color-danger)' }}>{keywordsSaveError}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
