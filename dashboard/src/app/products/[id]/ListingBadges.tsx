import type { CSSProperties } from 'react'
import InfoTooltip from '../../InfoTooltip'

const soldBadgeStyle: CSSProperties = {
  display: 'inline-block',
  marginLeft: 8,
  padding: '1px 8px',
  borderRadius: 12,
  fontSize: '0.75em',
  background: 'var(--color-text-muted)',
  color: 'var(--color-bg)',
}

export function SoldBadge() {
  return <span style={soldBadgeStyle}>Sold</span>
}

const repostBadgeStyle: CSSProperties = {
  display: 'inline-block',
  marginLeft: 8,
  padding: '1px 8px',
  borderRadius: 12,
  fontSize: '0.75em',
  background: 'var(--color-text-muted)',
  color: 'var(--color-bg)',
}

export function RepostBadge() {
  return <span style={repostBadgeStyle}>Possible repost</span>
}

// Solid fill, not a border-only pill - this now also renders as an overlay
// on top of arbitrary product photos (card view), where an outline-only
// badge wouldn't reliably read against a busy image.
const negotiableBadgeStyle: CSSProperties = {
  display: 'inline-block',
  marginLeft: 8,
  padding: '1px 8px',
  borderRadius: 12,
  fontSize: '0.75em',
  background: 'var(--color-accent)',
  color: 'var(--color-bg)',
}

export function NegotiableBadge() {
  return <span style={negotiableBadgeStyle}>Negotiable</span>
}

function discountBadgeStyle(percent: number): CSSProperties {
  return {
    display: 'inline-block',
    marginLeft: 8,
    padding: '1px 8px',
    borderRadius: 12,
    fontSize: '0.75em',
    background: percent > 0 ? 'var(--color-signal)' : 'var(--color-text-muted)',
    color: 'var(--color-bg)',
  }
}

// null covers both "not enough sibling listings to compare" and "this
// listing's price is itself a magnitude outlier / placeholder" - see
// computeListingDiscount. Zero is a real result (priced exactly at the
// reference), just not worth a badge.
// reasoning is the model's own verification writeup (discount-verification.ts's
// VerificationOutcome, 'verified' case) - only present for a listing that
// actually triggered and passed a discount_notifications check, not every
// listing with a nonzero discount_percent (that's a plain stats comparison,
// computed for all of them regardless of verification).
export function DiscountBadge({ percent, reasoning }: { percent: number | null; reasoning?: string | null }) {
  if (percent === null || percent === 0) return null
  return (
    <span style={discountBadgeStyle(percent)}>
      {percent > 0 ? `${percent}% below avg` : `${Math.abs(percent)}% above avg`}
      {reasoning && <InfoTooltip text={reasoning} style={{ marginLeft: 4 }} />}
    </span>
  )
}
