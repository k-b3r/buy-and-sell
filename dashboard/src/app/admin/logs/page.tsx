'use client'

import { useEffect, useRef, useState } from 'react'
import InfoTooltip from '../../InfoTooltip'

// Mirrors server/routes/logs.ts's WORKER_LOG_FILES / workerControl.ts's
// WORKER_PID_FILES keys - kept in sync by hand since dashboard/ and server/
// are separate packages with no shared import path.
const WORKERS = [
  'collect',
  'check-listings',
  'extract-products',
  'enrich-products',
  'price-lookup',
  'enrich-listing-prices',
  'extract-real-estate',
  'verify-discount-notifications',
] as const

type Worker = (typeof WORKERS)[number]

const WORKER_DESCRIPTIONS: Record<Worker, string> = {
  collect: 'Scrapes Marketplace search results for new motivated-seller listings.',
  'check-listings': 'Revisits stored listings to confirm still live, mark sold/removed, refresh fields.',
  'extract-products': 'LLM-extracts base model/variant from listings, links each to a product.',
  'enrich-products': 'LLM-enriches product records with category and eligibility.',
  'price-lookup': 'Web-search-grounded market price lookup per product.',
  'enrich-listing-prices': "LLM price review flagging listings priced as outliers vs. their product's range.",
  'extract-real-estate': 'LLM-extracts structured fields (type, price basis, area, project) from real estate listings.',
  'verify-discount-notifications':
    'Confirms candidate discounts against fresh market data before they reach the dashboard.',
}

const POLL_INTERVAL_MS = 3000

interface LogsResponse {
  lines: string[]
  nextOffset: number
}

interface StatusResponse {
  running: boolean
  lastRunErrored: boolean
}

export default function LogsPage() {
  const [worker, setWorker] = useState<Worker>('collect')
  const [lines, setLines] = useState<string[]>([])
  const [statuses, setStatuses] = useState<Partial<Record<Worker, StatusResponse>>>({})
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [startAllPending, setStartAllPending] = useState(false)
  const offsetRef = useRef<number | undefined>(undefined)
  const paneRef = useRef<HTMLPreElement>(null)
  const stickToBottomRef = useRef(true)
  // Guards against the 3s status poll (now a batch across all 7 workers) and
  // a manual Start/Stop click racing each other - whichever fetch resolves
  // LAST otherwise wins regardless of which was actually more recent, so a
  // poll issued right before a click could overwrite that click's fresher
  // result a moment later (confirmed live: button flips back to "Start"
  // briefly, next click then 409s because the worker was never actually
  // stopped). Bumping this on every status-affecting request and checking it
  // on resolution makes only the most-recently-issued request's result ever
  // apply - a stale batch poll gets discarded wholesale, not just the one
  // worker an action touched.
  const requestIdRef = useRef(0)

  const selectedStatus = statuses[worker]
  const running = selectedStatus?.running ?? null

  // Log tail for the selected worker only - clear the pane and start over
  // from a fresh tail on switch rather than waiting for the next poll tick.
  useEffect(() => {
    let cancelled = false
    offsetRef.current = undefined
    setLines([])
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

    poll()
    const interval = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [worker])

  // Status for ALL workers, not just the selected one - drives the spinner
  // and error-red on every tab, not only the currently-viewed one.
  useEffect(() => {
    let cancelled = false

    async function pollAllStatuses() {
      const requestId = ++requestIdRef.current
      try {
        const results = await Promise.all(
          WORKERS.map(async (w) => {
            const res = await fetch('/api/worker-control', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ worker: w, action: 'status' }),
            })
            if (!res.ok) return null
            return [w, (await res.json()) as StatusResponse] as const
          }),
        )
        if (cancelled || requestId !== requestIdRef.current) return
        setStatuses((prev) => {
          const next = { ...prev }
          for (const entry of results) {
            if (entry) next[entry[0]] = entry[1]
          }
          return next
        })
      } catch {
        // transient network hiccup - next tick tries again
      }
    }

    pollAllStatuses()
    const interval = setInterval(pollAllStatuses, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

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
    // Bumped up front, before the request even goes out - invalidates any
    // status poll already in flight so its (now-stale) result can't land
    // after this action's and overwrite it. See requestIdRef's comment.
    const requestId = ++requestIdRef.current
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
      if (requestId === requestIdRef.current) {
        setStatuses((prev) => ({ ...prev, [worker]: body as StatusResponse }))
      }
    } catch {
      setActionError('Could not reach the refresh service')
    } finally {
      setActionPending(false)
    }
  }

  // Fires start for every worker not already running, in parallel. A worker
  // already running 409s ("X is already running") - expected, not surfaced
  // as an error, since "start all" is meant to be safe to click repeatedly
  // (e.g. after a tunnel drop takes out a couple of workers but not others).
  async function handleStartAll() {
    setStartAllPending(true)
    setActionError(null)
    const requestId = ++requestIdRef.current
    try {
      const results = await Promise.all(
        WORKERS.map(async (w) => {
          const res = await fetch('/api/worker-control', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ worker: w, action: 'start' }),
          })
          const body = await res.json()
          if (!res.ok) return { worker: w, alreadyRunning: body.error?.includes('already running') ?? false }
          return { worker: w, status: body as StatusResponse }
        }),
      )
      if (requestId !== requestIdRef.current) return
      setStatuses((prev) => {
        const next = { ...prev }
        for (const r of results) {
          if (r.status) next[r.worker] = r.status
        }
        return next
      })
      const failed = results.filter((r) => !r.status && !r.alreadyRunning)
      if (failed.length > 0) setActionError(`Failed to start: ${failed.map((r) => r.worker).join(', ')}`)
    } catch {
      setActionError('Could not reach the refresh service')
    } finally {
      setStartAllPending(false)
    }
  }

  return (
    <div>
      <h1>Workers</h1>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        {WORKERS.map((w) => {
          const status = statuses[w]
          const isSelected = w === worker
          // Red means "last run ended badly AND it's not running now" - once
          // restarted, the spinner already shows it's active, so red would
          // just read as stale/confusing layered on top of that.
          const isError = (status?.lastRunErrored ?? false) && !status?.running
          return (
            // InfoTooltip's trigger is a <button> - can't nest it inside the
            // worker-select button (invalid HTML, and its click would bubble
            // into setWorker) - sibling span instead, same visual grouping.
            <span key={w} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <button
                onClick={() => setWorker(w)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: isSelected ? 'var(--color-accent)' : isError ? 'var(--color-danger-bg)' : 'transparent',
                  color: isSelected ? 'var(--color-bg)' : isError ? 'var(--color-danger)' : 'var(--color-text)',
                  border: `1px solid ${isError && !isSelected ? 'var(--color-danger)' : 'var(--color-border)'}`,
                  borderRadius: 8,
                  padding: '4px 10px',
                  fontSize: '0.85em',
                  cursor: 'pointer',
                }}
              >
                {status?.running && <span className="spinner" aria-label="running" />}
                {w}
              </button>
              <InfoTooltip
                text={WORKER_DESCRIPTIONS[w]}
                style={{ fontSize: '0.85em', color: 'var(--color-text-muted)' }}
              />
            </span>
          )
        })}
        <button
          onClick={handleStartAll}
          disabled={startAllPending}
          title="Start every worker not already running"
          style={{
            background: 'transparent',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            padding: '4px 10px',
            fontSize: '0.85em',
            cursor: startAllPending ? 'default' : 'pointer',
            marginLeft: 'auto',
          }}
        >
          {startAllPending ? 'Starting…' : 'Start all'}
        </button>
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
        {actionError && <span style={{ fontSize: '0.8em', color: 'var(--color-danger)' }}>{actionError}</span>}
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
