import type { CSSProperties } from 'react'

// Placeholder bar for a line of text (title, price, etc). Percentage widths
// so it scales with its container instead of a fixed px guess.
export function SkeletonLine({
  width = '100%',
  height = 14,
  style,
}: {
  width?: string | number
  height?: number
  style?: CSSProperties
}) {
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

// Mirrors DealRow's layout (deals/DealsClient.tsx) - horizontal row with a
// square thumb, a text block, and a right-aligned price block - not the
// square-card grid SkeletonCard/SkeletonGrid render, which is what the
// nearest ancestor loading.tsx (app/loading.tsx, "Products") falls back to
// without a dedicated deals/loading.tsx (confirmed live 2026-09-02: /deals
// briefly showed a "Products" heading and photo-grid skeleton).
export function SkeletonDealRow() {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        padding: 12,
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
      }}
    >
      <div className="skeleton" style={{ width: 64, height: 64, borderRadius: 6, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SkeletonLine width="60%" height={16} />
        <SkeletonLine width="35%" height={12} />
        <SkeletonLine width="45%" height={12} />
      </div>
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
        <SkeletonLine width={80} height={18} />
        <SkeletonLine width={50} height={12} />
        <SkeletonLine width={70} height={12} />
      </div>
    </div>
  )
}

// Mirrors ListingDetailContent's layout (title/price/table/description next
// to a square media block) - reuses the same .listing-detail-* classes so it
// inherits the real component's container-query two-column behavior for
// free instead of duplicating those breakpoints here.
export function SkeletonListingDetail({ showBackLink }: { showBackLink: boolean }) {
  return (
    <div className="listing-detail-container">
      {showBackLink && (
        <div style={{ marginBottom: 16 }}>
          <SkeletonLine width={140} height={16} />
        </div>
      )}
      <div className="listing-detail-layout">
        <div className="listing-detail-media">
          <div className="skeleton" style={{ width: '100%', aspectRatio: '1 / 1', borderRadius: 8 }} />
        </div>
        <div className="listing-detail-info">
          <SkeletonLine width="70%" height={28} style={{ marginBottom: 12 }} />
          <SkeletonLine width="35%" height={24} style={{ marginBottom: 16 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
            <SkeletonLine width={160} height={14} />
            <SkeletonLine width={140} height={14} />
            <SkeletonLine width={180} height={14} />
          </div>
          <SkeletonLine width="100%" height={14} style={{ marginBottom: 8 }} />
          <SkeletonLine width="95%" height={14} style={{ marginBottom: 8 }} />
          <SkeletonLine width="60%" height={14} />
        </div>
      </div>
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
