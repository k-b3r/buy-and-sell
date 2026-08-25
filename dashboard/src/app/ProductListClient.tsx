'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { PRODUCT_CATEGORIES, type ProductSummary } from '@/lib/queries'

interface ProductsPage {
  products: ProductSummary[]
  nextOffset: number | null
}

interface Props {
  initialProducts: ProductSummary[]
  initialNextOffset: number | null
  initialSearch: string
  initialCategory: string
}

export default function ProductListClient({
  initialProducts,
  initialNextOffset,
  initialSearch,
  initialCategory,
}: Props) {
  const [search, setSearch] = useState(initialSearch)
  const [category, setCategory] = useState(initialCategory)
  const [products, setProducts] = useState(initialProducts)
  const [nextOffset, setNextOffset] = useState(initialNextOffset)
  const [loading, setLoading] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const fetchPage = useCallback(async (q: string, cat: string, offset: number, replace: boolean) => {
    setLoading(true)
    const params = new URLSearchParams({ offset: String(offset) })
    if (q) params.set('q', q)
    if (cat) params.set('category', cat)
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
    if (search === initialSearch && category === initialCategory) return
    const timeout = setTimeout(() => fetchPage(search, category, 0, true), 300)
    return () => clearTimeout(timeout)
  }, [search, category, initialSearch, initialCategory, fetchPage])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || nextOffset === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading) fetchPage(search, category, nextOffset, false)
      },
      { rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [nextOffset, loading, search, category, fetchPage])

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Search by product name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: '1 1 200px', minWidth: 0, padding: 8, boxSizing: 'border-box' }}
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={{
            flex: '1 1 160px',
            minWidth: 0,
            padding: 8,
            background: 'var(--color-surface)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border)',
            borderRadius: 4,
          }}
        >
          <option value="">All categories</option>
          {PRODUCT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
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
              <span
                className="mono"
                style={{
                  position: 'absolute',
                  top: 8,
                  left: 8,
                  padding: '2px 8px',
                  borderRadius: 12,
                  fontSize: '0.75em',
                  background: 'var(--color-overlay-strong)',
                  color: '#fff',
                }}
              >
                {p.listing_count} listings
              </span>
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
              <div>
                <div style={{ fontWeight: 'bold' }}>{p.base_model}</div>
                {p.variant_tier && (
                  <div style={{ color: 'var(--color-text-muted)', fontSize: '0.9em' }}>{p.variant_tier}</div>
                )}
              </div>
              <div style={{ marginTop: 12 }}>
                <div className="mono" style={{ fontSize: '0.9em' }}>
                  {p.price_min !== null && p.price_max !== null
                    ? `₱${p.price_min.toLocaleString()}–₱${p.price_max.toLocaleString()}`
                    : 'No price data'}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  {p.price_avg !== null && (
                    <span
                      className="mono"
                      style={{
                        padding: '1px 6px',
                        borderRadius: 8,
                        fontSize: '0.65em',
                        background: 'var(--color-bg)',
                        border: '1px solid var(--color-border)',
                        color: 'var(--color-text-muted)',
                      }}
                    >
                      avg ₱{Math.round(p.price_avg).toLocaleString()}
                    </span>
                  )}
                  {p.secondhand_price_low !== null && p.secondhand_price_high !== null && (
                    <span
                      className="mono"
                      style={{
                        padding: '1px 6px',
                        borderRadius: 8,
                        fontSize: '0.65em',
                        fontWeight: 'bold',
                        background: 'var(--color-signal)',
                        color: 'var(--color-bg)',
                      }}
                    >
                      Secondhand ₱{p.secondhand_price_low.toLocaleString()}–₱{p.secondhand_price_high.toLocaleString()}
                    </span>
                  )}
                  {p.new_price_low !== null && p.new_price_high !== null && (
                    <span
                      className="mono"
                      style={{
                        padding: '1px 6px',
                        borderRadius: 8,
                        fontSize: '0.65em',
                        background: 'var(--color-bg)',
                        border: '1px solid var(--color-border)',
                        color: 'var(--color-text-muted)',
                      }}
                    >
                      New ₱{p.new_price_low.toLocaleString()}–₱{p.new_price_high.toLocaleString()}
                    </span>
                  )}
                </div>
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
