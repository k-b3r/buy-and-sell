'use client'

import { useState, type CSSProperties } from 'react'
import Link from 'next/link'
import type { ProductListingSummary } from '@/lib/queries'

type View = 'list' | 'cards'

function toggleButtonStyle(active: boolean): CSSProperties {
  return {
    background: active ? 'var(--color-text)' : 'transparent',
    color: active ? 'var(--color-bg)' : 'var(--color-text)',
    border: '1px solid var(--color-border)',
    borderRadius: 8,
    padding: '4px 12px',
    fontSize: '0.9em',
    cursor: 'pointer',
  }
}

export default function ListingsView({ listings }: { listings: ProductListingSummary[] }) {
  const [view, setView] = useState<View>('list')

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button
          onClick={() => setView('list')}
          aria-pressed={view === 'list'}
          style={toggleButtonStyle(view === 'list')}
        >
          List
        </button>
        <button
          onClick={() => setView('cards')}
          aria-pressed={view === 'cards'}
          style={toggleButtonStyle(view === 'cards')}
        >
          Cards
        </button>
      </div>

      {view === 'list' ? (
        <table cellPadding={8} style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--color-border)' }}>
              <th></th>
              <th>Title</th>
              <th>Condition</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            {listings.map((l) => (
              <tr key={l.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <td>
                  {l.primary_photo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.primary_photo_url} alt="" width={48} height={48} style={{ objectFit: 'cover' }} />
                  ) : null}
                </td>
                <td>
                  <Link href={`/listings/${l.id}`}>{l.title}</Link>
                </td>
                <td>{l.condition ?? '—'}</td>
                <td className="mono">{l.price_amount !== null ? `₱${l.price_amount.toLocaleString()}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16 }}>
          {listings.map((l) => (
            <Link
              key={l.id}
              href={`/listings/${l.id}`}
              style={{
                display: 'block',
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                overflow: 'hidden',
                color: 'inherit',
                textDecoration: 'none',
              }}
            >
              <div style={{ width: '100%', aspectRatio: '1 / 1', background: 'var(--color-bg)' }}>
                {l.primary_photo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={l.primary_photo_url}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                ) : null}
              </div>
              <div style={{ padding: 10 }}>
                <div style={{ fontSize: '0.9em' }}>{l.title}</div>
                <div style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginTop: 2 }}>
                  {l.condition ?? '—'}
                </div>
                <div className="mono" style={{ marginTop: 4 }}>
                  {l.price_amount !== null ? `₱${l.price_amount.toLocaleString()}` : '—'}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
