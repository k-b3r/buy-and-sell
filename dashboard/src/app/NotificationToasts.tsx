'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import InfoTooltip from './InfoTooltip'
import ListingThumb from './ListingThumb'
import { useNotifications } from './NotificationsProvider'
import { selectNewToasts } from '@/lib/notificationToasts'
import type { DiscountNotification } from '@/lib/queries'

const AUTO_DISMISS_MS = 6000

const containerStyle: CSSProperties = {
  position: 'fixed',
  bottom: 16,
  right: 16,
  display: 'flex',
  flexDirection: 'column-reverse',
  gap: 10,
  zIndex: 30,
  width: 320,
}

const toastStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  gap: 10,
  padding: 12,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  boxShadow: '0 8px 24px var(--color-overlay)',
  textDecoration: 'none',
  color: 'var(--color-text)',
}

const dismissStyle: CSSProperties = {
  position: 'absolute',
  top: 4,
  right: 6,
  background: 'transparent',
  border: 'none',
  color: 'var(--color-text-muted)',
  fontSize: '0.9em',
  cursor: 'pointer',
  lineHeight: 1,
}

// Ephemeral pop-ups, bottom-right, for a listing flagged as a deal WHILE the
// dashboard's open - distinct from NotificationBell's persistent dropdown,
// which always shows the full backlog regardless of when it arrived. Shares
// NotificationsProvider's single poll (see its comment) instead of polling
// again itself; selectNewToasts (src/lib/notificationToasts.ts) is what
// turns "the poll just refreshed" into "these specific rows are new".
export default function NotificationToasts() {
  const { notifications, markRead } = useNotifications()
  const [visible, setVisible] = useState<DiscountNotification[]>([])
  const baselineRef = useRef<string | null>(null)
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  function dismiss(id: number) {
    setVisible((prev) => prev.filter((n) => n.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }

  useEffect(() => {
    const { toasts, nextBaselineIso } = selectNewToasts(notifications, baselineRef.current)
    baselineRef.current = nextBaselineIso
    if (toasts.length === 0) return

    setVisible((prev) => [...prev, ...toasts])
    for (const t of toasts) {
      timersRef.current.set(
        t.id,
        setTimeout(() => dismiss(t.id), AUTO_DISMISS_MS),
      )
    }
  }, [notifications])

  // Timers must outlive this effect's own re-runs (a new poll shouldn't
  // cancel an already-showing toast's countdown) - cleanup only fires on
  // unmount, by design, not listed as a per-render effect dependency.
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
    }
  }, [])

  function handleClick(id: number) {
    markRead(id)
    dismiss(id)
  }

  if (visible.length === 0) return null

  return (
    <div style={containerStyle}>
      {visible.map((n) => (
        <Link key={n.id} href={`/listings/${n.listing_id}`} style={toastStyle} onClick={() => handleClick(n.id)}>
          <ListingThumb photoUrl={n.primary_photo_url} size={48} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontWeight: 600,
                fontSize: '0.85em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {n.title ?? 'Listing'}
            </div>
            <div style={{ fontSize: '0.8em', color: 'var(--color-signal)' }}>
              {n.discount_percent}% below market
              {n.verification_reasoning && (
                <InfoTooltip
                  text={n.verification_reasoning}
                  style={{ marginLeft: 4, color: 'var(--color-text-muted)' }}
                />
              )}
            </div>
          </div>
          <button
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              dismiss(n.id)
            }}
            aria-label="Dismiss"
            style={dismissStyle}
          >
            ×
          </button>
        </Link>
      ))}
    </div>
  )
}
