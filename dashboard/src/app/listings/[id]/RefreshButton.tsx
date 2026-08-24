'use client'

import { useState, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'

const refreshButtonStyle: CSSProperties = {
  background: 'transparent',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  padding: '4px 10px',
  fontSize: '0.85em',
  cursor: 'pointer',
}

// Hits /api/listings/[id]/refresh, which hands off to refresh-server.ts on
// the box that actually runs a browser - see that route for why. router.refresh()
// re-fetches this server component's data on success, so a price/description
// edit picked up by the re-scrape shows up immediately without a manual reload.
export default function RefreshButton({ listingId }: { listingId: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null)

  async function handleClick() {
    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/listings/${listingId}/refresh`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        setMessage({ text: body.error ?? 'Refresh failed', isError: true })
        return
      }
      setMessage({ text: `Status: ${body.status}`, isError: false })
      router.refresh()
    } catch {
      setMessage({ text: 'Refresh failed - could not reach the refresh service', isError: true })
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
        <span
          style={{
            fontSize: '0.8em',
            color: message.isError ? 'var(--color-signal)' : 'var(--color-text-muted)',
          }}
        >
          {message.text}
        </span>
      )}
    </span>
  )
}
