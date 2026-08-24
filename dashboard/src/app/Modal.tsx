'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import { getCycleTarget } from './listings/[id]/cycle'
import { backIconStyle } from './backIconStyle'
import BackIcon from './BackIcon'
import { marketplaceButtonStyle } from './marketplaceButtonStyle'
import FacebookIcon from './FacebookIcon'

function navButtonStyle(side: 'left' | 'right'): CSSProperties {
  return {
    position: 'absolute',
    top: '50%',
    [side]: 12,
    transform: 'translateY(-50%)',
    width: 40,
    height: 40,
    borderRadius: '50%',
    border: '1px solid var(--color-border)',
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    fontSize: '1.3rem',
    lineHeight: 1,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }
}

// currentId drives cycling through whatever listing list was last visible
// in ListingsView (see its sessionStorage write) - optional because Modal
// has no other caller today, but a future non-listing modal shouldn't be
// forced to wire up cycling it doesn't need.
export default function Modal({ children, currentId }: { children: React.ReactNode; currentId?: string }) {
  const router = useRouter()
  const [prevId, setPrevId] = useState<string | null>(null)
  const [nextId, setNextId] = useState<string | null>(null)

  useEffect(() => {
    if (!currentId) return
    try {
      const raw = sessionStorage.getItem('listingCycleIds')
      const ids: string[] = raw ? JSON.parse(raw) : []
      const target = getCycleTarget(ids, currentId)
      setPrevId(target.prevId)
      setNextId(target.nextId)
    } catch {
      setPrevId(null)
      setNextId(null)
    }
  }, [currentId])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') router.back()
      if (e.key === 'ArrowLeft' && prevId) router.replace(`/listings/${prevId}`)
      if (e.key === 'ArrowRight' && nextId) router.replace(`/listings/${nextId}`)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [router, prevId, nextId])

  return (
    <div
      onClick={() => router.back()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'var(--color-overlay)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        padding: '3vh 16px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 960,
          maxHeight: '94vh',
          // column layout, content clipped at this level: the button row
          // below is a normal-flow sibling (not absolutely positioned over
          // the content), and only the content pane scrolls - so the
          // buttons never move, however long the listing's description is.
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
        }}
      >
        <div style={{ position: 'relative', flexShrink: 0, height: 56 }}>
          {prevId && (
            <button onClick={() => router.replace(`/listings/${prevId}`)} aria-label="Previous listing" style={navButtonStyle('left')}>
              ‹
            </button>
          )}
          {nextId && (
            <button onClick={() => router.replace(`/listings/${nextId}`)} aria-label="Next listing" style={navButtonStyle('right')}>
              ›
            </button>
          )}
        </div>
        <div style={{ overflowY: 'auto', padding: '0 24px 24px' }}>{children}</div>
        <button
          onClick={() => router.back()}
          aria-label="Back to listings"
          title="Back to listings"
          style={{ ...backIconStyle, position: 'absolute', bottom: 16, left: 16 }}
        >
          <BackIcon />
        </button>
        {currentId && (
          // Absolute to this box (position:relative above), not fixed to
          // the viewport - stays anchored inside the modal card, unaffected
          // by the content pane's own scroll.
          <a
            href={`https://www.facebook.com/marketplace/item/${currentId}/`}
            target="_blank"
            rel="noreferrer"
            aria-label="View on Marketplace"
            title="View on Marketplace"
            style={{ ...marketplaceButtonStyle, position: 'absolute', bottom: 16, right: 16 }}
          >
            <FacebookIcon />
          </a>
        )}
      </div>
    </div>
  )
}
