import { notFound } from 'next/navigation'
import { getProductDetailCached } from '@/lib/cachedQueries'
import ListingsView from './ListingsView'
import { paginateListings, parseListingsFilters } from './listingsFilters'
import RefreshProductButton from './RefreshProductButton'
import BackLink from '../../BackLink'

// Live data - prerendering would pin it to build time, and would also make
// the build depend on server/ being reachable from the build container (see
// analytics/page.tsx). Freshness is cachedQueries.ts's job, not the build's.
export const dynamic = 'force-dynamic'


export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { id } = await params
  const sp = await searchParams
  const from = sp.from
  const productId = Number(id)
  const product = await getProductDetailCached(productId)
  if (!product) notFound()

  // A listing link back here (see ListingsView's `back` param) carries the
  // listing-view filters (sort/hide-sold/discount-band/etc.) it was clicked
  // from - seed ListingsView with them instead of always starting over.
  const initialFilters = parseListingsFilters(
    new URLSearchParams(Object.entries(sp).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  )
  // First page of listings, computed the exact same way the
  // /api/products/[id]/listings route computes every subsequent page - see
  // paginateListings's comment for why this doesn't re-run the discount
  // median calc or hit the DB again.
  const initialPage = paginateListings(product.listings, initialFilters, 0)

  return (
    <div>
      <p>
        {/* from carries the product list's filters (category/sub-category/
            search) as a raw querystring - set by ProductListClient's card
            links (see its `from` param comment) so this button returns to
            the exact filtered view instead of resetting to "/". */}
        <BackLink href={from ? `/?${from}` : '/'} label="Back to products" />
      </p>
      <h1>
        {product.base_model}
        {product.variant_tier ? ` — ${product.variant_tier}` : ''}
      </h1>
      {product.secondhand_price_low !== null && product.secondhand_price_high !== null && (
        <p className="mono" style={{ color: 'var(--color-signal)' }}>
          Secondhand price: ₱{product.secondhand_price_low.toLocaleString()}–₱
          {product.secondhand_price_high.toLocaleString()} ({product.secondhand_price_source})
        </p>
      )}
      {product.new_price_low !== null && product.new_price_high !== null && (
        <p className="mono" style={{ color: 'var(--color-text-muted)' }}>
          New retail price: ₱{product.new_price_low.toLocaleString()}–₱{product.new_price_high.toLocaleString()}
        </p>
      )}
      {product.enrichment && (
        <section style={{ margin: '1rem 0' }}>
          <p>{product.enrichment.description}</p>
          <p>
            <strong>Value drivers:</strong> {product.enrichment.value_drivers}
          </p>
          {product.enrichment.has_trained_price_knowledge &&
          product.enrichment.trained_price_low !== null &&
          product.enrichment.trained_price_high !== null ? (
            <p className="mono">
              Trained price knowledge: ₱{product.enrichment.trained_price_low.toLocaleString()}–₱
              {product.enrichment.trained_price_high.toLocaleString()}
              {product.enrichment.trained_price_currency && product.enrichment.trained_price_currency !== 'PHP'
                ? ` ${product.enrichment.trained_price_currency}`
                : ''}
            </p>
          ) : (
            <p className="mono" style={{ opacity: 0.7 }}>
              No trained price knowledge for this model
            </p>
          )}
          <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            via {product.enrichment.model}, checked {new Date(product.enrichment.checked_at).toLocaleDateString()}
          </p>
        </section>
      )}

      <h2>
        Listings ({product.listings.length}){' '}
        <span style={{ fontSize: '0.6em', verticalAlign: 'middle' }}>
          <RefreshProductButton productId={product.id} />
        </span>
      </h2>
      <ListingsView
        initialListings={initialPage.listings}
        initialNextOffset={initialPage.nextOffset}
        initialMatchedCount={initialPage.matchedCount}
        initialAllIds={initialPage.allIds}
        totalListingCount={product.listings.length}
        discountBands={product.discount_bands}
        productId={product.id}
        initialFilters={initialFilters}
      />
    </div>
  )
}
