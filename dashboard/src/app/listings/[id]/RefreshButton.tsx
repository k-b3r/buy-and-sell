'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'

const TOAST_DURATION_MS = 4000

const toastStyle: CSSProperties = {
  position: 'fixed',
  bottom: 24,
  right: 24,
  zIndex: 200,
  padding: '10px 16px',
  borderRadius: 8,
  color: '#fff',
  boxShadow: '0 4px 12px var(--color-overlay)',
  fontSize: '0.85em',
}

// alive is the only outcome that means "still a real, available listing" -
// everything else (sold, removed, flagged, a hard-block, or a request that
// failed outright) reads as red, per direct instruction.
const TOAST_GREEN = '#16a34a'
const TOAST_RED = '#dc2626'
type ToastTone = 'green' | 'red'

const refreshButtonStyle: CSSProperties = {
  background: 'transparent',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  padding: '4px 10px',
  fontSize: '0.85em',
  cursor: 'pointer',
}

// Hits /api/listings/[id]/refresh, which hands off to the server's refresh
// route (server/routes/refresh.ts) on the box that actually runs a browser -
// see that route for why. router.refresh() re-fetches this server component's data on success, so a price/description
// edit picked up by the re-scrape shows up immediately without a manual reload.
//
// status:'removed' means checkOneListing already hard-deleted the row (see
// src/check-listings.ts) - this page's own getListingDetail/getProductDetail
// call would now 404. router.refresh() would re-render THIS now-gone route,
// which - worse, inside the listing modal, a parallel-route slot - throws
// notFound() there and takes the whole layout down instead of just this
// slot (confirmed live 2026-08-24). Navigating away instead sidesteps
// re-rendering the dead route at all.
export default function RefreshButton({ listingId, productId }: { listingId: string; productId: number | null }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ text: string; tone: ToastTone } | null>(null)

  // Auto-dismiss - a toast that lingers forever just becomes a second
  // permanent status line, defeating the point of it being a toast.
  useEffect(() => {
    if (!message) return
    const timeout = setTimeout(() => setMessage(null), TOAST_DURATION_MS)
    return () => clearTimeout(timeout)
  }, [message])

  async function handleClick() {
    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/listings/${listingId}/refresh`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        setMessage({ text: body.error ?? 'Refresh failed', tone: 'red' })
        return
      }
      if (body.status === 'removed') {
        setMessage({ text: 'Listing removed - going back…', tone: 'red' })
        router.push(productId ? `/products/${productId}` : '/')
        return
      }
      setMessage({ text: `Status: ${body.status}`, tone: body.status === 'alive' ? 'green' : 'red' })
      router.refresh()
    } catch {
      setMessage({ text: 'Refresh failed - could not reach the refresh service', tone: 'red' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button onClick={handleClick} disabled={loading} style={refreshButtonStyle}>
        {loading ? 'Refreshing…' : '↻ Refresh'}
      </button>
      {message && (
        // span, not div - this component renders inside a <p> in
        // ListingDetailContent.tsx, and HTML forbids a block element there
        // (real hydration error, confirmed live). position:fixed below
        // blockifies it visually regardless of tag, per the CSS spec.
        <span
          className="mono"
          style={{ ...toastStyle, background: message.tone === 'green' ? TOAST_GREEN : TOAST_RED }}
        >
          {listingId}: {message.text}
        </span>
      )}
    </span>
  )
}
