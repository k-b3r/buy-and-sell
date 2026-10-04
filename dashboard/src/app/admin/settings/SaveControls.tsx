import type { SaveState } from './settingsTypes'

export default function SaveControls({
  state,
  error,
  onSave,
}: {
  state: SaveState
  error: string | undefined
  onSave: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
      <button
        onClick={onSave}
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
      {state === 'error' && <span style={{ fontSize: '0.8em', color: 'var(--color-danger)' }}>{error}</span>}
    </div>
  )
}
