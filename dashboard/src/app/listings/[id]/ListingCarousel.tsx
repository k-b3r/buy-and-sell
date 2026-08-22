'use client'

import { useState, type CSSProperties, type MouseEvent } from 'react'

interface Props {
  photoUrls: string[]
  title: string
}

const ZOOM_SCALE = 2

const ARROW_HIT_PADDING = 14

// The button is a padded, invisible hit-area — bigger than the visible
// circle — so the cursor de-zooms (see handleMouseMove) before it's even
// over the circle, instead of right as it touches it.
function arrowButtonStyle(side: 'left' | 'right'): CSSProperties {
  return {
    position: 'absolute',
    top: '50%',
    [side]: 0,
    transform: 'translateY(-50%)',
    padding: ARROW_HIT_PADDING,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }
}

const arrowCircleStyle: CSSProperties = {
  width: 36,
  height: 36,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--color-overlay)',
  color: '#fff',
  borderRadius: '50%',
  fontSize: '1.4em',
  lineHeight: 1,
}

export default function ListingCarousel({ photoUrls, title }: Props) {
  const [index, setIndex] = useState(0)
  const [zoomed, setZoomed] = useState(false)
  const [origin, setOrigin] = useState('center')

  if (photoUrls.length === 0) return null

  const goPrev = () => setIndex((i) => (i - 1 + photoUrls.length) % photoUrls.length)
  const goNext = () => setIndex((i) => (i + 1) % photoUrls.length)

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    // Arrows/counter sit on top of the image inside this same container —
    // when the cursor is over one of them, the event target is the button,
    // not the img, so back off the zoom instead of fighting it for hover.
    if ((e.target as HTMLElement).tagName !== 'IMG') {
      setZoomed(false)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 100
    const y = ((e.clientY - rect.top) / rect.height) * 100
    setOrigin(`${x}% ${y}%`)
    setZoomed(true)
  }

  return (
    <div style={{ margin: '1rem 0' }}>
      <div
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setZoomed(false)}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 500,
          aspectRatio: '1 / 1',
          overflow: 'hidden',
          borderRadius: 4,
          background: 'var(--color-bg)',
          cursor: 'zoom-in',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photoUrls[index]}
          alt={`${title} photo ${index + 1}`}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
            transform: zoomed ? `scale(${ZOOM_SCALE})` : 'scale(1)',
            transformOrigin: origin,
            transition: zoomed ? 'transform 0.1s ease-out' : 'transform 0.2s ease-out',
          }}
        />
        {photoUrls.length > 1 && (
          <>
            <button onClick={goPrev} aria-label="Previous photo" style={arrowButtonStyle('left')}>
              <span style={arrowCircleStyle}>‹</span>
            </button>
            <button onClick={goNext} aria-label="Next photo" style={arrowButtonStyle('right')}>
              <span style={arrowCircleStyle}>›</span>
            </button>
            <div
              style={{
                position: 'absolute',
                bottom: 8,
                right: 8,
                background: 'var(--color-overlay-strong)',
                color: '#fff',
                padding: '2px 8px',
                borderRadius: 12,
                fontSize: '0.8em',
              }}
              className="mono"
            >
              {index + 1} / {photoUrls.length}
            </div>
          </>
        )}
      </div>

      {photoUrls.length > 1 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          {photoUrls.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={url}
              alt=""
              onClick={() => setIndex(i)}
              style={{
                width: 56,
                height: 56,
                objectFit: 'cover',
                borderRadius: 4,
                cursor: 'pointer',
                border: i === index ? '2px solid var(--color-signal)' : '2px solid transparent',
                opacity: i === index ? 1 : 0.7,
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
