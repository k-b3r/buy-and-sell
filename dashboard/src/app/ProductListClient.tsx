'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PRODUCT_CATEGORIES } from '@/lib/shared.generated'
import type { ProductSummary, SubCategoryTreeEntry } from '@/lib/queries'
import { Spinner } from './Skeleton'

interface ProductsPage {
  products: ProductSummary[]
  nextOffset: number | null
}

interface Props {
  initialProducts: ProductSummary[]
  initialNextOffset: number | null
  initialSearch: string
  initialCategories: string[]
  initialSubCategories: string[]
  subCategoryTree: SubCategoryTreeEntry[]
}

const sortedKey = (values: string[]) => [...values].sort().join(',')

// sessionStorage (not localStorage) - "keep filters during a session" per
// direct request, not forever across tabs/days. Same try/catch-guarded
// pattern as ListingsView's listingCycleIds.
const FILTER_STORAGE_KEY = 'productFilters'

type ProductFilters = { search: string; category: string | null; subCategories: string[] }

function saveFilters(filters: ProductFilters) {
  try {
    sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters))
  } catch {
    // sessionStorage unavailable (private mode, etc.) - filters just won't persist
  }
}

function loadFilters(): ProductFilters | null {
  try {
    const raw = sessionStorage.getItem(FILTER_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as ProductFilters) : null
  } catch {
    return null
  }
}

// Shared with the card-link `from` param below - one construction so the
// URL synced into the address bar and the URL a product card remembers to
// come back to can never drift apart.
function buildFilterQueryString({ search, category, subCategories }: ProductFilters): string {
  const params = new URLSearchParams()
  if (search) params.set('q', search)
  if (category) params.append('category', category)
  for (const sc of subCategories) params.append('subCategory', sc)
  return params.toString()
}

export default function ProductListClient({
  initialProducts,
  initialNextOffset,
  initialSearch,
  initialCategories,
  initialSubCategories,
  subCategoryTree,
}: Props) {
  const [search, setSearch] = useState(initialSearch)
  const [category, setCategory] = useState<string | null>(initialCategories[0] ?? null)
  const [subCategories, setSubCategories] = useState(initialSubCategories)
  const [products, setProducts] = useState(initialProducts)
  const [nextOffset, setNextOffset] = useState(initialNextOffset)
  const [loading, setLoading] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const router = useRouter()

  const fetchPage = useCallback(async (filters: ProductFilters, offset: number, replace: boolean) => {
    setLoading(true)
    const params = new URLSearchParams(buildFilterQueryString(filters))
    params.set('offset', String(offset))
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

  // Tracks the filters this component itself last pushed into the URL (via
  // router.replace below). Distinguishes "the URL changed because we just
  // pushed it" (initial* props echo back matching - no-op) from "the URL
  // changed some other way" (Home link, browser back/forward past our
  // history entry, a hand-edited address bar - any of these change initial*
  // props without local state ever having moved). In the latter case local
  // state is stale and must adopt the new URL, not fight it back to the old
  // filters - see the sync effect below.
  const appliedFiltersRef = useRef<ProductFilters>({
    search: initialSearch,
    category: initialCategories[0] ?? null,
    subCategories: initialSubCategories,
  })

  // Local edits (typing, picking a category, toggling a chip) debounce into
  // a fetch + URL replace.
  useEffect(() => {
    const applied = appliedFiltersRef.current
    if (
      search === applied.search &&
      category === applied.category &&
      sortedKey(subCategories) === sortedKey(applied.subCategories)
    )
      return
    const timeout = setTimeout(() => {
      const filters = { search, category, subCategories }
      appliedFiltersRef.current = filters
      saveFilters(filters)
      void fetchPage(filters, 0, true)
      // Mirror filters into the URL via next/navigation's router, not raw
      // history.replaceState - Next's client router keeps its own history/
      // cache stack separate from the browser's, keyed off entries it
      // navigated. A raw replaceState edits the address bar but leaves that
      // stack pointing at the old (filter-less) entry, so browser back
      // restores Next's stale cached render instead of the filtered one.
      // router.replace re-syncs both.
      const qs = buildFilterQueryString(filters)
      router.replace(qs ? `/?${qs}` : '/', { scroll: false })
    }, 300)
    return () => clearTimeout(timeout)
  }, [search, category, subCategories, fetchPage, router])

  // External navigation (Home link, browser back/forward, a bookmarked/
  // shared filtered URL) changes initial* without local state ever moving -
  // adopt it instead of leaving the effect above fight it back to stale
  // filters (confirmed live 2026-08-29: clicking "Ledger" home while a
  // category was selected snapped the URL right back to that category).
  useEffect(() => {
    const initialCategory = initialCategories[0] ?? null
    const applied = appliedFiltersRef.current
    if (
      initialSearch === applied.search &&
      initialCategory === applied.category &&
      sortedKey(initialSubCategories) === sortedKey(applied.subCategories)
    )
      return
    const filters = { search: initialSearch, category: initialCategory, subCategories: initialSubCategories }
    appliedFiltersRef.current = filters
    saveFilters(filters)
    setSearch(initialSearch)
    setCategory(initialCategory)
    setSubCategories(initialSubCategories)
    void fetchPage(filters, 0, true)
  }, [initialSearch, initialCategories, initialSubCategories, fetchPage])

  // Restore session-persisted filters when landing on a completely
  // filter-less URL - e.g. the "Ledger" logo link is a bare "/", which
  // otherwise wiped whatever category/search was selected. A URL that
  // already carries filters (shared link, browser back/forward) always
  // wins; sessionStorage only fills in when the URL has nothing to say.
  // Mount-only by design (empty deps) - this is a one-time "did I arrive
  // with no filters" check, not something that should re-run as the user
  // edits filters afterward.
  useEffect(() => {
    if (initialSearch || initialCategories.length > 0 || initialSubCategories.length > 0) return
    const stored = loadFilters()
    if (!stored || (!stored.search && !stored.category && stored.subCategories.length === 0)) return
    appliedFiltersRef.current = stored
    setSearch(stored.search)
    setCategory(stored.category)
    setSubCategories(stored.subCategories)
    void fetchPage(stored, 0, true)
    const qs = buildFilterQueryString(stored)
    router.replace(qs ? `/?${qs}` : '/', { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount to restore saved filters
  }, [])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || nextOffset === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading)
          void fetchPage({ search, category, subCategories }, nextOffset, false)
      },
      { rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [nextOffset, loading, search, category, subCategories, fetchPage])

  const toggleSubCategory = (sc: string) => {
    setSubCategories((prev) => (prev.includes(sc) ? prev.filter((x) => x !== sc) : [...prev, sc]))
  }

  const visibleSubCategories = category ? subCategoryTree.filter((e) => e.parentCategory === category) : []

  // Carried on every product card link as `?from=` so the product page's
  // "Back to products" button returns to this exact filtered view instead
  // of a bare "/" - confirmed live 2026-08-29: without it, going back from
  // a product wiped the category/sub-category filters.
  const listQueryString = buildFilterQueryString({ search, category, subCategories })

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <select
          value={category ?? ''}
          onChange={(e) => {
            setCategory(e.target.value || null)
            setSubCategories([])
          }}
          className="mono"
          style={{
            padding: 8,
            borderRadius: 4,
            fontSize: '0.85em',
            border: '1px solid var(--color-border)',
            background: 'var(--color-surface)',
            color: 'var(--color-text)',
          }}
        >
          <option value="">All categories</option>
          {PRODUCT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search by product name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: '1 1 200px', minWidth: 0, padding: 8, boxSizing: 'border-box' }}
        />
      </div>
      {visibleSubCategories.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {visibleSubCategories.map(({ subCategory: sc }) => {
            const active = subCategories.includes(sc)
            return (
              <button
                key={sc}
                type="button"
                onClick={() => toggleSubCategory(sc)}
                className="mono"
                style={{
                  padding: '4px 10px',
                  borderRadius: 999,
                  fontSize: '0.75em',
                  border: `1px solid ${active ? 'var(--color-signal)' : 'var(--color-border)'}`,
                  background: active ? 'var(--color-signal)' : 'var(--color-surface)',
                  color: active ? 'var(--color-bg)' : 'var(--color-text)',
                  cursor: 'pointer',
                }}
              >
                {sc}
              </button>
            )
          })}
        </div>
      )}
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
            href={
              listQueryString ? `/products/${p.id}?from=${encodeURIComponent(listQueryString)}` : `/products/${p.id}`
            }
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
                // eslint-disable-next-line @next/next/no-img-element -- listing photos are remote CDN URLs; next/image has no remotePatterns configured
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
                {p.sub_category && (
                  <span
                    className="mono"
                    style={{
                      display: 'inline-block',
                      marginTop: 4,
                      padding: '1px 6px',
                      borderRadius: 8,
                      fontSize: '0.65em',
                      background: 'var(--color-bg)',
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    {p.sub_category}
                  </span>
                )}
              </div>
              <div style={{ marginTop: 12 }}>
                <div className="mono" style={{ fontSize: '0.9em' }}>
                  {p.price_min !== null && p.price_max !== null
                    ? `₱${p.price_min.toLocaleString()}–₱${p.price_max.toLocaleString()}`
                    : 'No price data'}
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, marginTop: 6 }}
                >
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
                      Avg ₱{Math.round(p.price_avg).toLocaleString()}
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
                      Used ₱{p.secondhand_price_low.toLocaleString()}–₱{p.secondhand_price_high.toLocaleString()}
                    </span>
                  )}
                  {p.new_price_low !== null && p.new_price_high !== null && (
                    <span
                      className="mono"
                      style={{
                        padding: '1px 6px',
                        borderRadius: 8,
                        fontSize: '0.65em',
                        // Fixed light blue, not var(--color-accent) - that
                        // swaps hue per theme, and black text needs a light
                        // fill regardless of theme to stay readable.
                        background: '#60a5fa',
                        color: '#000',
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
      {loading && <Spinner label="Loading more products" />}
      {!loading && nextOffset === null && products.length > 0 && (
        <p style={{ color: 'var(--color-text-muted)' }}>End of list.</p>
      )}
      {!loading && products.length === 0 && <p style={{ color: 'var(--color-text-muted)' }}>No products found.</p>}
    </div>
  )
}
