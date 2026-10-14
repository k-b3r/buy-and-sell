import { getProductSummaries, getSubCategoryTree, isExclusionsUiEnabled } from '@/lib/queries'
import ProductListClient from './ProductListClient'

// Live data - prerendering would pin it to build time, and would also make
// the build depend on server/ being reachable from the build container (see
// analytics/page.tsx). Freshness is the server's cache's job, not the build's.
export const dynamic = 'force-dynamic'

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string | string[]; subCategory?: string | string[] }>
}) {
  const { q, category, subCategory } = await searchParams
  const search = q ?? ''
  const categories = category === undefined ? [] : Array.isArray(category) ? category : [category]
  const subCategories = subCategory === undefined ? [] : Array.isArray(subCategory) ? subCategory : [subCategory]
  const [{ products, nextOffset }, subCategoryTree, showExclusions] = await Promise.all([
    getProductSummaries({ search, categories, subCategories }),
    getSubCategoryTree(),
    isExclusionsUiEnabled(),
  ])

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
        showExclusions={showExclusions}
      />
    </div>
  )
}
