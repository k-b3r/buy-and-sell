// Shared look for both tab bars (category and subgroup) - same
// selected/unselected treatment as admin/logs' worker-select buttons.
export default function TabButton({
  label,
  selected,
  onClick,
}: {
  label: string
  selected: boolean
  onClick: () => void
}) {
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
