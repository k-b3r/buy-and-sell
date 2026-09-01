'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

const BUBBLE_WIDTH = 240
const GAP = 8
const VIEWPORT_MARGIN = 8

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

type Phase = {
  rect: DOMRect
  left: number
  top: number
  direction: 'above' | 'below'
  ready: boolean
}

function bubbleStyle(phase: Phase): CSSProperties {
  return {
    position: 'fixed',
    zIndex: 1000,
    top: phase.top,
    left: phase.left,
    width: BUBBLE_WIDTH,
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
    opacity: phase.ready ? undefined : 0,
  }
}

// Replaces the native `title` attribute for hover info - that has no
// keyboard/touch support. Shown on hover, keyboard focus, or tap; dismissed
// on Escape/blur/mouseleave/scroll. Portals to <body> so it's never clipped
// by an ancestor's overflow:auto (NotificationBell's scrolling dropdown did
// exactly that to a flow-anchored bubble). Placement is two-pass: render
// once off-position to measure the bubble's real height (reasoning text is
// free-form/unbounded length, so a guessed height isn't reliable), then
// useLayoutEffect picks above/below and clamps to the viewport before the
// browser paints - the unmeasured frame is never actually shown.
export default function InfoTooltip({ text, style }: { text: string; style?: CSSProperties }) {
  const [phase, setPhase] = useState<Phase | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)
  const id = useId()

  function show() {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const left = clamp(centerX, BUBBLE_WIDTH / 2 + VIEWPORT_MARGIN, window.innerWidth - BUBBLE_WIDTH / 2 - VIEWPORT_MARGIN)
    setPhase({ rect, left, top: rect.bottom + GAP, direction: 'below', ready: false })
  }
  function hide() {
    setPhase(null)
  }

  useLayoutEffect(() => {
    if (!phase || phase.ready || !bubbleRef.current) return
    const height = bubbleRef.current.offsetHeight
    const spaceAbove = phase.rect.top
    const spaceBelow = window.innerHeight - phase.rect.bottom
    const fitsAbove = spaceAbove - GAP - height >= VIEWPORT_MARGIN
    const fitsBelow = spaceBelow - GAP - height >= VIEWPORT_MARGIN
    const direction = fitsAbove || (!fitsBelow && spaceAbove > spaceBelow) ? 'above' : 'below'
    const rawTop = direction === 'above' ? phase.rect.top - GAP - height : phase.rect.bottom + GAP
    const top = clamp(rawTop, VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN)
    setPhase((p) => (p ? { ...p, direction, top, ready: true } : p))
  }, [phase])

  useEffect(() => {
    if (!phase) return
    window.addEventListener('scroll', hide, { capture: true, once: true })
    return () => window.removeEventListener('scroll', hide, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase !== null])

  return (
    <span style={{ position: 'relative', display: 'inline-block', verticalAlign: style?.verticalAlign }}>
      <button
        ref={triggerRef}
        type="button"
        className="info-tooltip-trigger"
        aria-describedby={phase?.ready ? id : undefined}
        aria-label={text}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => (phase ? hide() : show())}
        onKeyDown={(e) => {
          if (e.key === 'Escape') hide()
        }}
        style={{ ...iconStyle, ...style }}
      >
        ⓘ
      </button>
      {phase &&
        createPortal(
          <span
            ref={bubbleRef}
            role="tooltip"
            id={id}
            className={phase.ready ? `info-tooltip-bubble info-tooltip-bubble--${phase.direction}` : undefined}
            style={bubbleStyle(phase)}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  )
}
