import Link from 'next/link'
import type { RealEstateListing } from '@/lib/queries'
import { formatAreaLine, formatPrice, formatReviewReason, PROPERTY_TYPE_LABELS } from '@/lib/realEstate'

const muted = { color: 'var(--color-text-muted)', fontSize: '0.8em', marginTop: 2 } as const
const chip = { fontSize: '0.75em', border: '1px solid var(--color-border)', borderRadius: 10, padding: '1px 8px' } as const

export default function RealEstateCard({ l }: { l: RealEstateListing }) {
  const area = formatAreaLine(l)
  const where = [l.project_name, l.area_text].filter(Boolean).join(' · ')
  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'hidden' }}>
      <Link href={`/listings/${l.id}`} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
        <div style={{ width: '100%', aspectRatio: '4 / 3', background: 'var(--color-bg)' }}>
          {l.primary_photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={l.primary_photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          ) : null}
        </div>
        <div style={{ padding: 10 }}>
          <div style={{ fontSize: '0.9em' }}>{l.title}</div>
          <div style={muted}>
            {PROPERTY_TYPE_LABELS[l.property_type] ?? l.property_type}
            {l.listing_type ? ` · ${l.listing_type === 'rent' ? 'For rent' : 'For sale'}` : ''}
          </div>
          {where ? <div style={muted}>{where}</div> : null}
          <div className="mono" style={{ marginTop: 6 }}>{formatPrice(l)}</div>
          {l.price_per_sqm !== null ? <div style={muted}>₱{Math.round(l.price_per_sqm).toLocaleString('en-US')} / sqm</div> : null}
          {area ? <div style={muted}>{area}</div> : null}
          {l.needs_review ? <div style={{ ...muted, marginTop: 4 }}>Under review: {formatReviewReason(l)}</div> : null}
          <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {l.tags.map((t) => (
              <span key={t} style={chip}>{t.replace('_', ' ')}</span>
            ))}
            {!l.needs_review && l.confidence !== 'high' ? <span style={{ fontSize: '0.75em', color: 'var(--color-text-muted)' }}>{l.confidence} confidence</span> : null}
          </div>
        </div>
      </Link>
    </div>
  )
}
