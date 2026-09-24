import Link from 'next/link'
import { getRealEstateListings } from '@/lib/queries'
import { NCR_AREAS, PROPERTY_TYPE_LABELS, REAL_ESTATE_PAGE_SIZE, parseRealEstateFilters } from '@/lib/realEstate'
import RealEstateCard from './RealEstateCard'

// Live data, same reasoning as deals/page.tsx: prerendering would pin it to
// build time and make every build depend on the VPS server being reachable.
export const dynamic = 'force-dynamic'

type RawParams = { [key: string]: string | string[] | undefined }

const field = { padding: '6px 8px', background: 'var(--color-surface)', color: 'inherit', border: '1px solid var(--color-border)', borderRadius: 6 } as const

// Real estate gets its own page rather than living under /products: listings are
// grouped by extracted property fields (real_estate_details), not by product.
// "Under review" holds what the extractor could not resolve - no stated price,
// sale/rent unclear, or low confidence - instead of showing a guessed number.
export default async function RealEstatePage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const raw = await searchParams
  const params: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  )
  const { filters, page } = parseRealEstateFilters(params)
  const listings = await getRealEstateListings(filters)
  const hasNext = listings.length === REAL_ESTATE_PAGE_SIZE
  const review = filters.view === 'review'

  const pageHref = (p: number) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries({ ...params, page: String(p) })) if (v) q.set(k, v)
    return `/real-estate?${q.toString()}`
  }

  return (
    <div>
      <h1>Real estate</h1>
      <div style={{ display: 'flex', gap: 16, margin: '12px 0' }}>
        <Link href="/real-estate" style={{ fontWeight: review ? 400 : 700 }}>Listings</Link>
        <Link href="/real-estate?view=review" style={{ fontWeight: review ? 700 : 400 }}>Under review</Link>
      </div>
      <form method="get" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '0 0 20px', alignItems: 'center' }}>
        {review ? <input type="hidden" name="view" value="review" /> : null}
        <select name="kind" defaultValue={params.kind ?? ''} style={field}>
          <option value="">Sale &amp; rent</option>
          <option value="sale">For sale</option>
          <option value="rent">For rent</option>
        </select>
        <select name="type" defaultValue={params.type ?? ''} style={field}>
          <option value="">Any type</option>
          {Object.entries(PROPERTY_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select name="area" defaultValue={params.area ?? ''} style={field}>
          <option value="">Any city</option>
          {NCR_AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <input name="project" placeholder="Project / building" defaultValue={params.project ?? ''} style={field} />
        <input name="min" type="number" min="0" placeholder="Min ₱" defaultValue={params.min ?? ''} style={{ ...field, width: 110 }} />
        <input name="max" type="number" min="0" placeholder="Max ₱" defaultValue={params.max ?? ''} style={{ ...field, width: 110 }} />
        <input name="sqm" type="number" min="0" placeholder="Min sqm" defaultValue={params.sqm ?? ''} style={{ ...field, width: 100 }} />
        <select name="sort" defaultValue={params.sort ?? ''} style={field}>
          <option value="">Newest</option>
          <option value="price_asc">Price, low to high</option>
          <option value="price_desc">Price, high to low</option>
          <option value="ppsqm_asc">₱/sqm, low to high</option>
        </select>
        <label style={{ fontSize: '0.85em', display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" name="rooms" value="1" defaultChecked={params.rooms === '1'} /> Include room shares
        </label>
        <button type="submit" style={{ ...field, cursor: 'pointer' }}>Filter</button>
      </form>

      {listings.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>{review ? 'Nothing under review matches.' : 'No real estate listings match.'}</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {listings.map((l) => <RealEstateCard key={l.id} l={l} />)}
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, marginTop: 20 }}>
        {page > 1 ? <Link href={pageHref(page - 1)}>← Previous</Link> : null}
        {hasNext ? <Link href={pageHref(page + 1)}>Next →</Link> : null}
      </div>
    </div>
  )
}
