'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PRODUCT_CATEGORIES } from '@/lib/shared.generated'
import type { ProductSummary, SubCategoryTreeEntry } from '@/lib/queries'
import ProductCard from './ProductCard'
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
          <ProductCard key={p.id} p={p} listQueryString={listQueryString} />
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
