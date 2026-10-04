import type { ProductNeedingReview } from '@/lib/queries'
import { formatTrainedPrice } from './reviewPrices'

const badgeStyle = {
  display: 'inline-block',
  padding: '1px 6px',
  borderRadius: 8,
  fontSize: '0.7em',
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  color: 'var(--color-text-muted)',
} as const

// What the reviewer judges the product on: its identity, classification
// badges and the enrichment pass's read on it.
export default function ProductReviewSummary({ product }: { product: ProductNeedingReview }) {
  const trainedPrice = formatTrainedPrice(product)
  return (
    <>
      <div style={{ fontWeight: 'bold' }}>{product.base_model}</div>
      {product.variant_tier && (
        <div style={{ color: 'var(--color-text-muted)', fontSize: '0.9em' }}>{product.variant_tier}</div>
      )}
      <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
        {product.category && (
          <span className="mono" style={badgeStyle}>
            {product.category}
          </span>
        )}
        {product.sub_category && (
          <span className="mono" style={badgeStyle}>
            {product.sub_category}
          </span>
        )}
        {product.enrichment?.confidence && (
          <span className="mono" style={badgeStyle}>
            confidence: {product.enrichment.confidence}
          </span>
        )}
        {product.enrichment?.is_specific_product === false && (
          <span className="mono" style={badgeStyle}>
            not specific
          </span>
        )}
      </div>

      {product.enrichment ? (
        <div style={{ marginTop: 8, fontSize: '0.9em' }}>
          <div>{product.enrichment.description}</div>
          <div style={{ color: 'var(--color-text-muted)', marginTop: 2 }}>{product.enrichment.value_drivers}</div>
          {trainedPrice && (
            <div style={{ color: 'var(--color-text-muted)', marginTop: 2 }}>
              Trained price knowledge: {trainedPrice}
            </div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 8, fontSize: '0.9em', color: 'var(--color-text-muted)' }}>No enrichment data.</div>
      )}
    </>
  )
}
