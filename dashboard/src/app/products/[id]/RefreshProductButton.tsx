'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'

interface RefreshJob {
  productId: number
  total: number
  completed: number
  status: 'running' | 'completed' | 'cancelled'
}

const buttonStyle: CSSProperties = {
  background: 'transparent',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  padding: '4px 10px',
  fontSize: '0.85em',
  cursor: 'pointer',
}

// Only one job runs server-wide at a time (see server/routes/refreshProduct.ts) -
// a poll response for a DIFFERENT productId means someone else's job is
// running, not this product's, so it's treated the same as no job.
export default function RefreshProductButton({ productId }: { productId: number }) {
  const router = useRouter()
  const [job, setJob] = useState<RefreshJob | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Picks up a job already in progress (e.g. this page was reloaded while
  // a previously-started refresh was still running).
  useEffect(() => {
    let cancelled = false
    fetch('/api/refresh-job')
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled && body && body.productId === productId) setJob(body)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [productId])

  // Lightweight polling, not push - see the brainstorming discussion this
  // followed; this codebase has no websocket/SSE infra anywhere else.
  useEffect(() => {
    if (job?.status !== 'running') return
    const poll = async () => {
      try {
        const res = await fetch('/api/refresh-job')
        const body = await res.json()
        setJob(res.ok && body && body.productId === productId ? body : null)
      } catch {
        // transient network hiccup - next tick tries again
      }
    }
    const interval = setInterval(() => void poll(), 2500)
    return () => clearInterval(interval)
  }, [job?.status, productId])

  // router.refresh() re-fetches the listing list once the job leaves
  // 'running' (completed, cancelled, or the poll lost track of it), so
  // whatever the batch changed (sold/removed/updated listings) shows up
  // without a manual reload.
  const jobStatus = job?.status
  useEffect(() => {
    if (jobStatus !== undefined && jobStatus !== 'running') router.refresh()
  }, [jobStatus, router])

  async function handleStart() {
    setStarting(true)
    setError(null)
    try {
      const res = await fetch(`/api/products/${productId}/refresh`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        setError(body.error ?? 'Failed to start refresh')
        return
      }
      setJob({ productId, total: body.total, completed: 0, status: body.total === 0 ? 'completed' : 'running' })
    } catch {
      setError('Could not reach the refresh service')
    } finally {
      setStarting(false)
    }
  }

  async function handleCancel() {
    try {
      await fetch('/api/refresh-job/cancel', { method: 'POST' })
    } catch {
      // next poll will just keep showing 'running' - user can retry cancel
    }
  }

  if (job?.status === 'running') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span className="mono" style={{ fontSize: '0.85em', color: 'var(--color-text-muted)' }}>
          Refreshing {job.completed} / {job.total}…
        </span>
        <button onClick={handleCancel} style={buttonStyle}>
          Cancel
        </button>
      </span>
    )
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button onClick={handleStart} disabled={starting} style={buttonStyle}>
        {starting ? 'Starting…' : '↻ Refresh all listings'}
      </button>
      {error && <span style={{ fontSize: '0.8em', color: 'var(--color-signal)' }}>{error}</span>}
    </span>
  )
}
