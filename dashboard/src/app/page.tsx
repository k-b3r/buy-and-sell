import { getPool } from '@/lib/db'
import { getProductSummaries } from '@/lib/queries'
import ProductListClient from './ProductListClient'

const PAGE_SIZE = 30

export default async function HomePage({ searchParams }: { searchParams: Promise<{ q?: string; category?: string }> }) {
  const { q, category } = await searchParams
  const search = q ?? ''
  const products = await getProductSummaries(getPool(), { search, category, offset: 0, limit: PAGE_SIZE })
  const nextOffset = products.length === PAGE_SIZE ? PAGE_SIZE : null

  return (
    <div>
      <h1>Products</h1>
      <ProductListClient
        initialProducts={products}
        initialNextOffset={nextOffset}
        initialSearch={search}
        initialCategory={category ?? ''}
      />
    </div>
  )
}
