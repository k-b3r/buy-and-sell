import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getPool } from '@/lib/db'
import { getProductDetail } from '@/lib/queries'
import ListingsView from './ListingsView'

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const productId = Number(id)
  const product = await getProductDetail(getPool(), productId)
  if (!product) notFound()

  return (
    <div>
      <p>
        <Link href="/">← Back to products</Link>
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

      <h2>Listings ({product.listings.length})</h2>
      <ListingsView listings={product.listings} />
    </div>
  )
}
