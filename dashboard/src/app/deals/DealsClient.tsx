'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { PRODUCT_CATEGORIES, type DealListing, type DealsConfidenceTier } from '@/lib/queries'
import SaveButton from '../SaveButton'
import { Spinner, SkeletonDealRow } from '../Skeleton'

interface DealsPage {
  deals: DealListing[]
  nextOffset: number | null
}

interface Filters {
  search: string
  category: string | null
  minProfit: string
  minTier: DealsConfidenceTier | ''
  maxDaysListed: string
  soldOnly: boolean
}

const EMPTY_FILTERS: Filters = { search: '', category: null, minProfit: '', minTier: '', maxDaysListed: '', soldOnly: false }

// Plain-language labels for the reference-price fallback chain (highest
// confidence first) - "sold_comps"/"peer_listings"/"llm_estimate" are the
// tier names used internally (getDeals, filters) but read as jargon on the
// page itself.
const TIER_LABELS: Record<DealsConfidenceTier, string> = {
  sold_comps: 'Based on recent sales',
  peer_listings: 'Based on similar listings',
  llm_estimate: 'AI estimate',
}

// Longer explanation for each tier, shown as a native tooltip on the badge -
// the short label alone doesn't say *why* one tier beats another.
const TIER_DESCRIPTIONS: Record<DealsConfidenceTier, string> = {
  sold_comps: 'Median asking price of this product\'s listings that have actually sold - the strongest signal, though Facebook doesn\'t show the final agreed price.',
  peer_listings: 'Median asking price of other active listings for this product - nobody has paid this yet.',
  llm_estimate: 'AI-researched price estimate - used when there aren\'t enough real listings to compare against.',
}

const TIER_COLORS: Record<DealsConfidenceTier, string> = {
  sold_comps: 'var(--color-signal)',
  peer_listings: '#60a5fa',
  llm_estimate: 'var(--color-text-muted)',
}

function buildParams(filters: Filters, offset: number, lowConfidence: boolean): URLSearchParams {
  const params = new URLSearchParams({ offset: String(offset) })
  if (filters.search) params.set('search', filters.search)
  if (filters.category) params.set('category', filters.category)
  if (filters.minProfit) params.set('minProfit', filters.minProfit)
  if (filters.minTier) params.set('minTier', filters.minTier)
  if (filters.maxDaysListed) params.set('maxDaysListed', filters.maxDaysListed)
  if (filters.soldOnly) params.set('soldOnly', 'true')
  if (lowConfidence) params.set('lowConfidence', 'true')
  return params
}

function DealRow({ deal }: { deal: DealListing }) {
  // Links into the same intercepted-route listing modal every other list
  // view uses (ListingsView.tsx, SavedListingsClient.tsx) instead of
  // straight out to Facebook - the modal has the FB link (and photo
  // carousel, description, condition, price review, verification notes)
  // already, so this is strictly more info than an external tab, without
  // losing the deals list underneath.
  const listingHref = `/listings/${deal.listing_id}`
  return (
    <Link
      href={listingHref}
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        padding: 12,
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        color: 'inherit',
        textDecoration: 'none',
      }}
    >
      <div style={{ flexShrink: 0 }}>
        <div style={{ width: 64, height: 64, borderRadius: 6, overflow: 'hidden', background: 'var(--color-bg)' }}>
          {deal.photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={deal.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          ) : null}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{deal.title}</div>
        <div style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginTop: 2 }}>
          {deal.base_model}
          {deal.variant_tier ? ` — ${deal.variant_tier}` : ''}
          {deal.category ? ` · ${deal.category}` : ''}
        </div>
        <div className="mono" style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>₱{deal.ask_price.toLocaleString()}</span>
          {deal.reference_price !== null && (
            <span style={{ color: 'var(--color-text-muted)' }}>vs ₱{Math.round(deal.reference_price).toLocaleString()}</span>
          )}
          {deal.tier && (
            <span
              title={TIER_DESCRIPTIONS[deal.tier]}
              style={{
                padding: '1px 6px',
                borderRadius: 8,
                fontSize: '0.75em',
                background: TIER_COLORS[deal.tier],
                color: deal.tier === 'llm_estimate' ? 'var(--color-bg)' : '#000',
                cursor: 'help',
              }}
            >
              {TIER_LABELS[deal.tier]}
              {deal.comp_count !== null && ` (${deal.comp_count})`}
            </span>
          )}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        {deal.profit_pesos !== null ? (
          <div className="mono" style={{ fontWeight: 'bold', fontSize: '1.1em', color: 'var(--color-signal)' }}>
            +₱{Math.round(deal.profit_pesos).toLocaleString()}
          </div>
        ) : (
          <div className="mono" style={{ color: 'var(--color-text-muted)' }}>No estimate</div>
        )}
        {deal.discount_percent !== null && (
          <div className="mono" style={{ fontSize: '0.85em', color: 'var(--color-text-muted)' }}>{deal.discount_percent}% off</div>
        )}
        {deal.days_listed !== null && (
          <div className="mono" style={{ fontSize: '0.8em', color: 'var(--color-text-muted)' }}>
            {deal.days_listed === 1 ? '1 day listed' : `${deal.days_listed} days listed`}
          </div>
        )}
        {/* Est. days-to-sell (median sold_at - listed_at per product) - shipped
            as a placeholder per user decision (2026-09-02): the query doesn't
            exist yet, and blocking the whole page on it wasn't worth it. */}
        <div className="mono" style={{ fontSize: '0.75em', color: 'var(--color-text-muted)', opacity: 0.6 }}>
          Days-to-sell: coming soon
        </div>
        <div style={{ marginTop: 6 }}>
          <SaveButton listingId={deal.listing_id} productId={deal.product_id} initialSaved={deal.is_saved} variant="icon" />
        </div>
      </div>
    </Link>
  )
}

export default function DealsClient({
  initialDeals,
  initialNextOffset,
  initialLowConfidenceDeals,
  initialLowConfidenceNextOffset,
}: {
  initialDeals: DealListing[]
  initialNextOffset: number | null
  initialLowConfidenceDeals: DealListing[]
  initialLowConfidenceNextOffset: number | null
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [deals, setDeals] = useState(initialDeals)
  const [nextOffset, setNextOffset] = useState(initialNextOffset)
  const [loading, setLoading] = useState(false)
  const [lowConfidenceDeals, setLowConfidenceDeals] = useState(initialLowConfidenceDeals)
  const [lowConfidenceNextOffset, setLowConfidenceNextOffset] = useState(initialLowConfidenceNextOffset)
  const [lowConfidenceLoading, setLowConfidenceLoading] = useState(false)
  // Distinct from loading (infinite-scroll "load more") - true only while a
  // filter change's refetch is in flight, so the stale list gets swapped for
  // skeleton rows instead of sitting there while a spinner appends below it.
  const [filtersLoading, setFiltersLoading] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const appliedFiltersRef = useRef(EMPTY_FILTERS)

  const fetchPage = useCallback(async (f: Filters, offset: number, replace: boolean) => {
    setLoading(true)
    const res = await fetch(`/api/deals?${buildParams(f, offset, false)}`)
    const data: DealsPage = await res.json()
    setDeals((prev) => {
      if (replace) return data.deals
      const seen = new Set(prev.map((d) => d.listing_id))
      return [...prev, ...data.deals.filter((d) => !seen.has(d.listing_id))]
    })
    setNextOffset(data.nextOffset)
    setLoading(false)
  }, [])

  const fetchLowConfidencePage = useCallback(async (f: Filters, offset: number) => {
    setLowConfidenceLoading(true)
    const res = await fetch(`/api/deals?${buildParams(f, offset, true)}`)
    const data: DealsPage = await res.json()
    setLowConfidenceDeals((prev) => [...prev, ...data.deals])
    setLowConfidenceNextOffset(data.nextOffset)
    setLowConfidenceLoading(false)
  }, [])

  // Filter edits debounce into a refetch of both buckets - same shape as
  // ProductListClient's search debounce, minus the URL/sessionStorage sync
  // (skipped for v1: a shared-link/persisted-filter deals view is less
  // valuable than for the product catalog, since "what's a good deal right
  // now" is inherently a moment-in-time view, not something worth bookmarking).
  useEffect(() => {
    const applied = appliedFiltersRef.current
    if (JSON.stringify(filters) === JSON.stringify(applied)) return
    const timeout = setTimeout(() => {
      appliedFiltersRef.current = filters
      setLowConfidenceDeals([])
      setFiltersLoading(true)
      Promise.all([fetchPage(filters, 0, true), fetchLowConfidencePage(filters, 0)]).finally(() => setFiltersLoading(false))
    }, 300)
    return () => clearTimeout(timeout)
  }, [filters, fetchPage, fetchLowConfidencePage])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || nextOffset === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading) fetchPage(filters, nextOffset, false)
      },
      { rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [nextOffset, loading, filters, fetchPage])

  const inputStyle = {
    padding: 8,
    borderRadius: 4,
    fontSize: '0.85em',
    border: '1px solid var(--color-border)',
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Search title or product"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          className="mono"
          style={{ ...inputStyle, width: 220 }}
        />
        <select
          value={filters.category ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value || null }))}
          className="mono"
          style={inputStyle}
        >
          <option value="">All categories</option>
          {PRODUCT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={filters.minTier}
          onChange={(e) => setFilters((f) => ({ ...f, minTier: e.target.value as DealsConfidenceTier | '' }))}
          className="mono"
          style={inputStyle}
        >
          <option value="">Any reliability</option>
          <option value="peer_listings">Similar listings or better</option>
          <option value="sold_comps">Recent sales only</option>
        </select>
        <input
          type="number"
          placeholder="Min profit ₱"
          value={filters.minProfit}
          onChange={(e) => setFilters((f) => ({ ...f, minProfit: e.target.value }))}
          className="mono"
          style={{ ...inputStyle, width: 130 }}
        />
        <input
          type="number"
          placeholder="Max days listed"
          value={filters.maxDaysListed}
          onChange={(e) => setFilters((f) => ({ ...f, maxDaysListed: e.target.value }))}
          className="mono"
          style={{ ...inputStyle, width: 140 }}
        />
        <button
          type="button"
          onClick={() => setFilters((f) => ({ ...f, soldOnly: !f.soldOnly }))}
          className="mono"
          style={{
            ...inputStyle,
            cursor: 'pointer',
            background: filters.soldOnly ? 'var(--color-signal)' : 'var(--color-surface)',
            color: filters.soldOnly ? 'var(--color-bg)' : 'var(--color-text)',
          }}
        >
          {filters.soldOnly ? 'Sold' : 'Active'}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtersLoading
          ? Array.from({ length: 6 }, (_, i) => <SkeletonDealRow key={i} />)
          : deals.map((d) => <DealRow key={d.listing_id} deal={d} />)}
      </div>
      <div ref={sentinelRef} style={{ height: 1 }} />
      {!filtersLoading && loading && <Spinner label="Loading more deals" />}
      {!filtersLoading && !loading && nextOffset === null && deals.length > 0 && (
        <p style={{ color: 'var(--color-text-muted)' }}>End of list.</p>
      )}
      {!filtersLoading && !loading && deals.length === 0 && (
        <p style={{ color: 'var(--color-text-muted)' }}>No deals match these filters.</p>
      )}

      {lowConfidenceDeals.length > 0 && (
        <div style={{ marginTop: 40 }}>
          <h2 style={{ fontSize: '1.1em' }}>Rougher estimates</h2>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginTop: -8 }}>
            Products we've only ever seen listed once, or with no price estimate at all. There could be real deals
            in here, but the numbers are shakier - take with a grain of salt. Not sorted by profit.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            {lowConfidenceDeals.map((d) => (
              <DealRow key={d.listing_id} deal={d} />
            ))}
          </div>
          {lowConfidenceNextOffset !== null && (
            <button
              type="button"
              onClick={() => fetchLowConfidencePage(filters, lowConfidenceNextOffset)}
              disabled={lowConfidenceLoading}
              className="mono"
              style={{ ...inputStyle, marginTop: 12, cursor: 'pointer' }}
            >
              {lowConfidenceLoading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
