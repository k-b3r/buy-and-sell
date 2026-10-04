const buttonStyle = {
  padding: '6px 12px',
  borderRadius: 6,
  fontSize: '0.85em',
  border: '1px solid var(--color-border)',
  cursor: 'pointer',
} as const

const primaryButtonStyle = {
  ...buttonStyle,
  background: 'var(--color-accent)',
  color: 'var(--color-bg)',
  borderColor: 'var(--color-accent)',
} as const

const secondaryButtonStyle = { ...buttonStyle, background: 'transparent', color: 'var(--color-text)' } as const

// Two-step button: the first click asks "{prompt}" inline with Yes/No. Only
// one action per row can be confirming or in flight at a time, so every
// other action's button is disabled meanwhile.
export default function ConfirmAction<K extends string>({
  kind,
  confirming,
  loading,
  onConfirmingChange,
  onConfirm,
  label,
  prompt,
  busyLabel,
  primary = false,
}: {
  kind: K
  confirming: K | null
  loading: K | null
  onConfirmingChange: (kind: K | null) => void
  onConfirm: () => void
  label: string
  prompt: string
  busyLabel: string
  primary?: boolean
}) {
  if (confirming === kind) {
    return (
      <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.85em' }}>
        {prompt}
        <button onClick={onConfirm} disabled={loading !== null} style={primaryButtonStyle}>
          {loading === kind ? busyLabel : 'Yes'}
        </button>
        <button onClick={() => onConfirmingChange(null)} disabled={loading !== null} style={secondaryButtonStyle}>
          No
        </button>
      </span>
    )
  }
  return (
    <button
      onClick={() => onConfirmingChange(kind)}
      disabled={loading !== null || confirming !== null}
      style={primary ? primaryButtonStyle : secondaryButtonStyle}
    >
      {label}
    </button>
  )
}
