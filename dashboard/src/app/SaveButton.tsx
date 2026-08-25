'use client'

import { useState, type CSSProperties } from 'react'

const buttonStyle: CSSProperties = {
  background: 'transparent',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  padding: '4px 10px',
  fontSize: '0.85em',
  cursor: 'pointer',
}

// Solid fill like the other card-overlay badges (see ListingsView.tsx's
// SoldBadge/NegotiableBadge) - needs to read against arbitrary product
// photos, an outline-only glyph wouldn't.
const iconStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  borderRadius: '50%',
  border: 'none',
  background: 'var(--color-surface)',
  color: 'var(--color-accent)',
  fontSize: '0.9em',
  cursor: 'pointer',
  lineHeight: 1,
}

// Toggle, not fire-and-forget like RefreshButton - optimistic local flip so
// it feels instant inside a card grid, with the fetch's result only used to
// revert on failure. The API route (api/listings/[id]/save/route.ts) does
// its own revalidateTag so other views pick up the change on next load.
//
// Cards in ListingsView.tsx wrap this whole button in a <Link> (click =
// navigate to the listing) - preventDefault/stopPropagation keeps a save
// click from also triggering that navigation. Harmless everywhere else
// (ListingDetailContent, the /saved page) since there's no enclosing Link there.
export default function SaveButton({
  listingId,
  productId,
  initialSaved,
  variant = 'button',
  onToggle,
}: {
  listingId: string
  productId: number | null
  initialSaved: boolean
  variant?: 'button' | 'icon'
  onToggle?: (saved: boolean) => void
}) {
  const [saved, setSaved] = useState(initialSaved)
  const [loading, setLoading] = useState(false)

  async function handleClick(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (loading) return

    const next = !saved
    setSaved(next)
    setLoading(true)
    try {
      const query = productId !== null ? `?productId=${productId}` : ''
      const res = await fetch(`/api/listings/${listingId}/save${query}`, { method: next ? 'POST' : 'DELETE' })
      if (!res.ok) {
        setSaved(!next)
        return
      }
      onToggle?.(next)
    } catch {
      setSaved(!next)
    } finally {
      setLoading(false)
    }
  }

  if (variant === 'icon') {
    return (
      <button onClick={handleClick} disabled={loading} style={iconStyle} aria-label={saved ? 'Unsave' : 'Save'} title={saved ? 'Unsave' : 'Save'}>
        {saved ? '★' : '☆'}
      </button>
    )
  }

  return (
    <button onClick={handleClick} disabled={loading} style={buttonStyle}>
      {saved ? '★ Saved' : '☆ Save'}
    </button>
  )
}
