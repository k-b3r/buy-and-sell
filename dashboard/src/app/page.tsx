import { getPool } from '@/lib/db'
import { getProductSummariesCached, getSubCategoryTreeCached } from '@/lib/cachedQueries'
import ProductListClient from './ProductListClient'

const PAGE_SIZE = 30

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string | string[]; subCategory?: string | string[] }>
}) {
  const { q, category, subCategory } = await searchParams
  const search = q ?? ''
  const categories = category === undefined ? [] : Array.isArray(category) ? category : [category]
  const subCategories = subCategory === undefined ? [] : Array.isArray(subCategory) ? subCategory : [subCategory]
  const [products, subCategoryTree] = await Promise.all([
    getProductSummariesCached(getPool(), { search, categories, subCategories, offset: 0, limit: PAGE_SIZE }),
    getSubCategoryTreeCached(getPool()),
  ])
  const nextOffset = products.length === PAGE_SIZE ? PAGE_SIZE : null

  return (
    <div>
      <h1>Products</h1>
      <ProductListClient
        initialProducts={products}
        initialNextOffset={nextOffset}
        initialSearch={search}
        initialCategories={categories}
        initialSubCategories={subCategories}
        subCategoryTree={subCategoryTree}
      />
    </div>
  )
}
