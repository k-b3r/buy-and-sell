import { getPool } from '@/lib/db'
import { getProductsNeedingReviewCached } from '@/lib/cachedQueries'
import NeedsReviewClient from './NeedsReviewClient'

export default async function NeedsReviewPage() {
  const products = await getProductsNeedingReviewCached(getPool())

  return (
    <div>
      <h1>Products needing review</h1>
      <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9em', maxWidth: 640 }}>
        Groq wasn&apos;t confident these base models name one real, specific, priceable product. Price-lookup skips
        them until resolved here - either confirm the product is fine, or exclude it from price lookup.
      </p>

      {products.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>Nothing needs review.</p>
      ) : (
        <NeedsReviewClient initialProducts={products} />
      )}
    </div>
  )
}
