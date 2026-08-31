'use client'

import { useId, useState, type CSSProperties } from 'react'

const iconStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'help',
}

const bubbleStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 40,
  bottom: '100%',
  left: '50%',
  transform: 'translateX(-50%)',
  marginBottom: 6,
  width: 240,
  padding: '8px 10px',
  borderRadius: 8,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  boxShadow: '0 8px 24px var(--color-overlay)',
  color: 'var(--color-text)',
  fontSize: '0.8rem',
  fontWeight: 400,
  lineHeight: 1.4,
  whiteSpace: 'normal',
  textAlign: 'left',
  cursor: 'default',
}

// Replaces the native `title` attribute for hover info - that has no
// keyboard/touch support. Shown on hover, keyboard focus, or tap; dismissed
// on Escape/blur/mouseleave. `style` lets each call site match the spacing/
// size/color of the badge it sits in (same as the span it replaces).
export default function InfoTooltip({ text, style }: { text: string; style?: CSSProperties }) {
  const [open, setOpen] = useState(false)
  const id = useId()

  return (
    <span style={{ position: 'relative', display: 'inline-block', verticalAlign: style?.verticalAlign }}>
      <button
        type="button"
        aria-describedby={open ? id : undefined}
        aria-label={text}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
        style={{ ...iconStyle, ...style }}
      >
        ⓘ
      </button>
      {open && (
        <span role="tooltip" id={id} style={bubbleStyle}>
          {text}
        </span>
      )}
    </span>
  )
}
