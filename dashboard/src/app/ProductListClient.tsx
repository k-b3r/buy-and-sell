'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { ProductSummary } from '@/lib/queries'

interface ProductsPage {
  products: ProductSummary[]
  nextOffset: number | null
}

interface Props {
  initialProducts: ProductSummary[]
  initialNextOffset: number | null
  initialSearch: string
}

export default function ProductListClient({ initialProducts, initialNextOffset, initialSearch }: Props) {
  const [search, setSearch] = useState(initialSearch)
  const [products, setProducts] = useState(initialProducts)
  const [nextOffset, setNextOffset] = useState(initialNextOffset)
  const [loading, setLoading] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const fetchPage = useCallback(async (q: string, offset: number, replace: boolean) => {
    setLoading(true)
    const params = new URLSearchParams({ offset: String(offset) })
    if (q) params.set('q', q)
    const res = await fetch(`/api/products?${params}`)
    const data: ProductsPage = await res.json()
    setProducts((prev) => {
      if (replace) return data.products
      const seen = new Set(prev.map((p) => p.id))
      return [...prev, ...data.products.filter((p) => !seen.has(p.id))]
    })
    setNextOffset(data.nextOffset)
    setLoading(false)
  }, [])

  useEffect(() => {
    if (search === initialSearch) return
    const timeout = setTimeout(() => fetchPage(search, 0, true), 300)
    return () => clearTimeout(timeout)
  }, [search, initialSearch, fetchPage])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || nextOffset === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading) fetchPage(search, nextOffset, false)
      },
      { rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [nextOffset, loading, search, fetchPage])

  return (
    <div>
      <input
        type="text"
        placeholder="Search by product name..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: '100%', padding: 8, marginBottom: 16, boxSizing: 'border-box' }}
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 16,
        }}
      >
        {products.map((p) => (
          <Link
            key={p.id}
            href={`/products/${p.id}`}
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
            <div style={{ width: '100%', aspectRatio: '1 / 1', background: 'var(--color-bg)', position: 'relative' }}>
              {p.sample_photo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.sample_photo_url}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              ) : null}
              {p.discount_bands.length > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    alignItems: 'flex-end',
                  }}
                >
                  {p.discount_bands.map((band) => (
                    <div
                      key={band.bandFloor}
                      className="mono"
                      style={{
                        padding: '2px 8px',
                        borderRadius: 12,
                        fontSize: '0.75em',
                        fontWeight: 'bold',
                        background: 'var(--color-signal)',
                        color: 'var(--color-bg)',
                      }}
                    >
                      {band.bandFloor}-{band.bandFloor + 9}% {band.count}x
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ padding: 12 }}>
              <div style={{ fontWeight: 'bold' }}>{p.base_model}</div>
              {p.variant_tier && (
                <div style={{ color: 'var(--color-text-muted)', fontSize: '0.9em' }}>{p.variant_tier}</div>
              )}
              <div className="mono" style={{ marginTop: 4 }}>
                {p.price_min !== null && p.price_max !== null
                  ? `₱${p.price_min.toLocaleString()}–₱${p.price_max.toLocaleString()}`
                  : 'No price data'}
              </div>
              {p.price_avg !== null && (
                <div className="mono" style={{ color: 'var(--color-text-muted)', fontSize: '0.9em' }}>
                  avg ₱{Math.round(p.price_avg).toLocaleString()}
                </div>
              )}
              {p.secondhand_price_low !== null && p.secondhand_price_high !== null && (
                <div className="mono" style={{ color: 'var(--color-signal)', fontSize: '0.9em', marginTop: 4 }}>
                  Secondhand: ₱{p.secondhand_price_low.toLocaleString()}–₱{p.secondhand_price_high.toLocaleString()}
                </div>
              )}
              {p.new_price_low !== null && p.new_price_high !== null && (
                <div className="mono" style={{ color: 'var(--color-text-muted)', fontSize: '0.9em' }}>
                  New: ₱{p.new_price_low.toLocaleString()}–₱{p.new_price_high.toLocaleString()}
                </div>
              )}
              <div style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginTop: 4 }}>
                {p.listing_count} listings
              </div>
            </div>
          </Link>
        ))}
      </div>
      <div ref={sentinelRef} style={{ height: 1 }} />
      {loading && <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>}
      {!loading && nextOffset === null && products.length > 0 && (
        <p style={{ color: 'var(--color-text-muted)' }}>End of list.</p>
      )}
      {!loading && products.length === 0 && <p style={{ color: 'var(--color-text-muted)' }}>No products found.</p>}
    </div>
  )
}
