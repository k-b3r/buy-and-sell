import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getExcludedProducts, getExclusionSummary, isExclusionsUiEnabled } from '@/lib/queries'
import { exclusionLabel, includeExplanation } from '@/lib/exclusionReasons'
import BackLink from '../BackLink'

// Live data, same reason as the other pages (see analytics/page.tsx).
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

// Products price lookup skips, grouped by why (BUY-36). Undo happens on each
// product's page. Uncached like /deals: right after an include, a stale
// count here would look like the include failed.
export default async function ExcludedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; page?: string }>
}) {
  if (!(await isExclusionsUiEnabled())) notFound()
  const { reason, page } = await searchParams

  if (!reason) {
    const summary = await getExclusionSummary()
    const total = summary.reduce((sum, row) => sum + row.count, 0)
    return (
      <div>
        <h1>Excluded from pricing</h1>
        <p style={{ opacity: 0.8 }}>
          {total.toLocaleString()} products are skipped by price lookup. Open one to include it again.
        </p>
        <ul>
          {summary.map((row) => (
            <li key={row.reason}>
              <Link href={`/excluded?reason=${encodeURIComponent(row.reason)}`}>{exclusionLabel(row.reason)}</Link>{' '}
              <span className="mono">({row.count.toLocaleString()})</span>
              {row.retry && <span style={{ opacity: 0.7 }}> · retryable</span>}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const pageNumber = Math.max(0, Number(page) || 0)
  const products = await getExcludedProducts(reason, { offset: pageNumber * PAGE_SIZE, limit: PAGE_SIZE })
  return (
    <div>
      <p>
        <BackLink href="/excluded" label="All reasons" />
      </p>
      <h1>{exclusionLabel(reason)}</h1>
      <p style={{ opacity: 0.8 }}>Including one: {includeExplanation(reason)}</p>
      {products.length === 0 ? (
        <p>No products here.</p>
      ) : (
        <ul>
          {products.map((p) => (
            <li key={p.id}>
              <Link href={`/products/${p.id}`}>
                {p.base_model}
                {p.variant_tier ? ` — ${p.variant_tier}` : ''}
              </Link>{' '}
              <span className="mono" style={{ opacity: 0.7 }}>
                ({p.listing_count} listings)
              </span>
            </li>
          ))}
        </ul>
      )}
      <p style={{ display: 'flex', gap: '1rem' }}>
        {pageNumber > 0 && (
          <Link href={`/excluded?reason=${encodeURIComponent(reason)}&page=${pageNumber - 1}`}>Previous</Link>
        )}
        {products.length === PAGE_SIZE && (
          <Link href={`/excluded?reason=${encodeURIComponent(reason)}&page=${pageNumber + 1}`}>Next</Link>
        )}
      </p>
    </div>
  )
}
