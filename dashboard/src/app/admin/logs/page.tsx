'use client'

import { useEffect, useRef, useState } from 'react'

// Mirrors server/routes/logs.ts's WORKER_LOG_FILES / workerControl.ts's
// WORKER_PID_FILES keys - kept in sync by hand since dashboard/ and server/
// are separate packages with no shared import path.
const WORKERS = [
  'collect',
  'check-listings',
  'extract-products',
  'enrich-products',
  'secondhand-price-lookup',
  'retail-price-lookup',
  'enrich-listing-prices',
] as const

const POLL_INTERVAL_MS = 3000

interface LogsResponse {
  lines: string[]
  nextOffset: number
}

interface StatusResponse {
  running: boolean
}

export default function LogsPage() {
  const [worker, setWorker] = useState<(typeof WORKERS)[number]>('collect')
  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState<boolean | null>(null)
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const offsetRef = useRef<number | undefined>(undefined)
  const paneRef = useRef<HTMLPreElement>(null)
  const stickToBottomRef = useRef(true)

  // Worker switch: clear the pane and start over from a fresh tail rather
  // than waiting for the next poll tick.
  useEffect(() => {
    let cancelled = false
    offsetRef.current = undefined
    setLines([])
    setRunning(null)
    setActionError(null)
    stickToBottomRef.current = true

    async function poll() {
      try {
        const res = await fetch('/api/logs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ worker, offset: offsetRef.current }),
        })
        const body: LogsResponse = await res.json()
        if (cancelled || !res.ok) return
        offsetRef.current = body.nextOffset
        if (body.lines.length > 0) setLines((prev) => [...prev, ...body.lines])
      } catch {
        // transient network hiccup - next tick tries again
      }
    }

    async function pollStatus() {
      try {
        const res = await fetch('/api/worker-control', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ worker, action: 'status' }),
        })
        const body: StatusResponse = await res.json()
        if (!cancelled && res.ok) setRunning(body.running)
      } catch {
        // transient network hiccup - next tick tries again
      }
    }

    poll()
    pollStatus()
    const interval = setInterval(() => {
      poll()
      pollStatus()
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [worker])

  // Auto-scroll to bottom on new lines, unless the user has scrolled up to
  // read earlier output - don't yank them back down mid-read.
  useEffect(() => {
    const pane = paneRef.current
    if (pane && stickToBottomRef.current) pane.scrollTop = pane.scrollHeight
  }, [lines])

  function handleScroll() {
    const pane = paneRef.current
    if (!pane) return
    stickToBottomRef.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40
  }

  async function handleToggleRunning() {
    if (running === null) return
    setActionPending(true)
    setActionError(null)
    try {
      const res = await fetch('/api/worker-control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worker, action: running ? 'stop' : 'start' }),
      })
      const body = await res.json()
      if (!res.ok) {
        setActionError(body.error ?? 'Action failed')
        return
      }
      setRunning((body as StatusResponse).running)
    } catch {
      setActionError('Could not reach the refresh service')
    } finally {
      setActionPending(false)
    }
  }

  return (
    <div>
      <h1>Worker logs</h1>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        {WORKERS.map((w) => (
          <button
            key={w}
            onClick={() => setWorker(w)}
            style={{
              background: w === worker ? 'var(--color-accent)' : 'transparent',
              color: w === worker ? 'var(--color-bg)' : 'var(--color-text)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              padding: '4px 10px',
              fontSize: '0.85em',
              cursor: 'pointer',
            }}
          >
            {w}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <span className="mono" style={{ fontSize: '0.85em', color: 'var(--color-text-muted)' }}>
          {running === null ? 'checking status…' : running ? 'running' : 'stopped'}
        </span>
        <button
          onClick={handleToggleRunning}
          disabled={running === null || actionPending}
          style={{
            background: 'transparent',
            color: running ? 'var(--color-signal)' : 'var(--color-text)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            padding: '4px 10px',
            fontSize: '0.85em',
            cursor: running === null || actionPending ? 'default' : 'pointer',
          }}
        >
          {actionPending ? 'Working…' : running ? 'Stop' : 'Start'}
        </button>
        {actionError && (
          <span style={{ fontSize: '0.8em', color: 'var(--color-signal)' }}>{actionError}</span>
        )}
      </div>
      <pre
        ref={paneRef}
        onScroll={handleScroll}
        className="mono"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: 12,
          height: '70vh',
          overflowY: 'auto',
          fontSize: '0.8em',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {lines.length > 0 ? lines.join('\n') : 'No log output yet.'}
      </pre>
    </div>
  )
}
