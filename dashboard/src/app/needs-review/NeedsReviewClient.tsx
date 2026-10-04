'use client'

import { useState } from 'react'
import type { ProductNeedingReview } from '@/lib/queries'
import ReviewRow from './ReviewRow'

export default function NeedsReviewClient({ initialProducts }: { initialProducts: ProductNeedingReview[] }) {
  const [products, setProducts] = useState(initialProducts)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 24 }}>
      {products.map((p) => (
        <ReviewRow key={p.id} product={p} onResolved={(id) => setProducts((prev) => prev.filter((x) => x.id !== id))} />
      ))}
    </div>
  )
}
