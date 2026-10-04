import type { ProductPriceHistoryEntry } from '@/lib/queries'

const priceInputStyle = {
  width: 90,
  padding: '4px 6px',
  borderRadius: 4,
  fontSize: '0.85em',
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
} as const

// Raw source string shown as-is (e.g. "manual_new_retail", "web_search") -
// per direct instruction (2026-08-29), no llm/api/computed relabeling, just
// keep it recognizable that manual entries say "manual".
function PriceHistoryList({ entries }: { entries: ProductPriceHistoryEntry[] }) {
  if (entries.length === 0)
    return <div style={{ fontSize: '0.75em', color: 'var(--color-text-muted)' }}>No history yet</div>

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '0.75em', color: 'var(--color-text-muted)' }}>
      {entries.map((entry) => (
        <li key={entry.id}>
          {entry.price_low != null && entry.price_high != null
            ? `₱${entry.price_low.toLocaleString()}–₱${entry.price_high.toLocaleString()}`
            : 'no price'}
          {' · '}
          <span className="mono">{entry.source}</span>
          {entry.condition && ` · ${entry.condition}`}
          {' · '}
          {new Date(entry.checked_at).toLocaleDateString()}
        </li>
      ))}
    </ul>
  )
}

// One price kind's min/max inputs plus the history of what was recorded for it.
export default function PriceRangeField({
  label,
  min,
  max,
  onMinChange,
  onMaxChange,
  history,
}: {
  label: string
  min: string
  max: string
  onMinChange: (value: string) => void
  onMaxChange: (value: string) => void
  history: ProductPriceHistoryEntry[]
}) {
  return (
    <div>
      <div style={{ fontSize: '0.75em', color: 'var(--color-text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          type="number"
          placeholder="min"
          value={min}
          onChange={(e) => onMinChange(e.target.value)}
          style={priceInputStyle}
        />
        <span style={{ color: 'var(--color-text-muted)' }}>-</span>
        <input
          type="number"
          placeholder="max"
          value={max}
          onChange={(e) => onMaxChange(e.target.value)}
          style={priceInputStyle}
        />
      </div>
      <div style={{ marginTop: 4 }}>
        <PriceHistoryList entries={history} />
      </div>
    </div>
  )
}
