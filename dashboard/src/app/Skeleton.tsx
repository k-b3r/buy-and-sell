import type { CSSProperties } from 'react'

// Placeholder bar for a line of text (title, price, etc). Percentage widths
// so it scales with its container instead of a fixed px guess.
export function SkeletonLine({ width = '100%', height = 14, style }: { width?: string | number; height?: number; style?: CSSProperties }) {
  return <div className="skeleton" style={{ width, height, ...style }} />
}

// Matches the card shape ProductListClient/ListingsView already render:
// square media placeholder + a couple of text bars underneath.
export function SkeletonCard() {
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div className="skeleton" style={{ width: '100%', aspectRatio: '1 / 1', borderRadius: 0 }} />
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SkeletonLine width="70%" />
        <SkeletonLine width="40%" height={12} />
      </div>
    </div>
  )
}

// Same repeat(auto-fill, minmax(minWidth, 1fr)) grid both real card grids
// use - pass the same minWidth as the real grid so the skeleton-to-content
// swap doesn't reflow the column count.
export function SkeletonGrid({ count, minWidth }: { count: number; minWidth: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))`, gap: 16 }}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  )
}

// Reuses the .spinner class already defined in globals.css (admin logs page)
// instead of a second animation - scaled up via font-size (spinner's
// width/height/border are all in em-free px, so transform is simpler here).
export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0' }}>
      <span className="spinner" aria-label={label} style={{ width: 18, height: 18, borderWidth: 3 }} />
    </div>
  )
}
