'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import BellIcon from './BellIcon'
import InfoTooltip from './InfoTooltip'
import { useNotifications } from './NotificationsProvider'

const bellButtonStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  width: 36,
  height: 36,
  cursor: 'pointer',
}

const badgeStyle: CSSProperties = {
  position: 'absolute',
  top: -4,
  right: -4,
  minWidth: 16,
  height: 16,
  padding: '0 4px',
  borderRadius: 8,
  background: 'var(--color-danger)',
  color: 'var(--color-bg)',
  fontSize: '0.65rem',
  lineHeight: '16px',
  fontWeight: 600,
}

const dropdownStyle: CSSProperties = {
  position: 'absolute',
  top: 44,
  right: 0,
  width: 340,
  maxHeight: 420,
  overflowY: 'auto',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  boxShadow: '0 8px 24px var(--color-overlay)',
  zIndex: 20,
}

const itemStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  padding: '10px 12px',
  borderBottom: '1px solid var(--color-border)',
  textDecoration: 'none',
  color: 'var(--color-text)',
}

const thumbStyle: CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 6,
  objectFit: 'cover',
  flexShrink: 0,
  background: 'var(--color-border)',
}

// Coarse buckets are enough for a notification list - no need for a
// library or exact minute-level precision here.
function relativeTime(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// Bell icon in the header, before ThemeToggle (see layout.tsx) - surfaces
// listings the pipeline itself just flagged as >=30% under their product's
// clean median (detectAndRecordDiscountNotifications, run once per listing
// right after extraction). Poll loop lives in NotificationsProvider, shared
// with NotificationToasts - this component just renders that shared state.
export default function NotificationBell() {
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={unreadCount > 0 ? `${unreadCount} unread deal notifications` : 'Deal notifications'}
        style={bellButtonStyle}
      >
        <BellIcon />
        {unreadCount > 0 && <span style={badgeStyle}>{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>
      {open && (
        <div style={dropdownStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--color-border)' }}>
            <strong style={{ fontSize: '0.85em' }}>Deal notifications</strong>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                style={{ background: 'transparent', border: 'none', color: 'var(--color-accent)', fontSize: '0.8em', cursor: 'pointer' }}
              >
                Mark all read
              </button>
            )}
          </div>
          {notifications.length === 0 && (
            <div style={{ padding: 16, fontSize: '0.85em', color: 'var(--color-text-muted)' }}>No deals flagged yet.</div>
          )}
          {notifications.map((n) => (
            <Link key={n.id} href={`/listings/${n.listing_id}`} style={itemStyle} onClick={() => markRead(n.id)}>
              <img src={n.primary_photo_url ?? ''} alt="" style={thumbStyle} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: n.read_at ? 400 : 600, fontSize: '0.85em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {n.title ?? 'Listing'}
                </div>
                <div style={{ fontSize: '0.8em', color: 'var(--color-signal)' }}>
                  {n.discount_percent}% below market
                  {n.verification_reasoning && (
                    <InfoTooltip text={n.verification_reasoning} style={{ marginLeft: 4, color: 'var(--color-text-muted)' }} />
                  )}
                </div>
                <div style={{ fontSize: '0.75em', color: 'var(--color-text-muted)' }}>{relativeTime(n.created_at)}</div>
              </div>
              {!n.read_at && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)', flexShrink: 0, marginTop: 4 }} />}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
