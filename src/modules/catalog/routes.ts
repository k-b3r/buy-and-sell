import express from 'express'
import type { Response, Router } from 'express'
import type { z } from 'zod'
import type { QueryClient } from '../../platform/storage'
import { paginateListings } from './listings-page'
import { getProductDetail } from './product-detail'
import { getProductSummaries, getSoldCountsBySubCategory, getSubCategoryTree } from './product-list'
import { getProductsNeedingReview, markProductReviewed } from './store/review-queue'
import { listingsQuerySchema, productIdParamSchema, productListQuerySchema } from './schemas'

// HTTP edge of the catalog feature, mounted by server/index.ts only (the
// module's index.ts does not export it, so workers never load express).
// Same contract the dashboard's /api/products* handlers had.

// The slice of server/cache.ts this router uses. Declared here because
// src/modules never import from server/ (the server's Cache satisfies it).
export interface RouteCache {
  wrap<T>(key: string, tags: string[], load: () => Promise<T>): Promise<T>
  invalidate(...tags: string[]): void
}

const PRODUCTS_PAGE_SIZE = 30

const productKey = (id: number) => `product:${id}`

function badRequest(res: Response, issues: z.core.$ZodIssue[]): void {
  res.status(400).json({ error: issues[0].message, issues })
}

export function createCatalogRouter(db: QueryClient, cache: RouteCache): Router {
  const router = express.Router()

  const productDetail = (id: number) =>
    cache.wrap(`product-detail:${id}`, [productKey(id)], () => getProductDetail(db, id))

  router.get('/products', async (req, res) => {
    const query = productListQuerySchema.safeParse(req.query)
    if (!query.success) return badRequest(res, query.error.issues)
    const { search, categories, subCategories, offset } = query.data

    // Sorted so selection order never fragments the cache.
    const key = JSON.stringify(['products', search ?? '', [...categories].sort(), [...subCategories].sort(), offset])
    const products = await cache.wrap(key, ['products-list'], () =>
      getProductSummaries(db, { search, categories, subCategories, offset, limit: PRODUCTS_PAGE_SIZE }),
    )
    const nextOffset = products.length === PRODUCTS_PAGE_SIZE ? offset + PRODUCTS_PAGE_SIZE : null
    res.json({ products, nextOffset })
  })

  // 200 with product: null for an unknown id: the dashboard's server
  // components turn that into notFound() without parsing an error status.
  router.get('/products/:id', async (req, res) => {
    const id = productIdParamSchema.safeParse(req.params.id)
    if (!id.success) return badRequest(res, id.error.issues)
    res.json({ product: await productDetail(id.data) })
  })

  router.get('/products/:id/listings', async (req, res) => {
    const id = productIdParamSchema.safeParse(req.params.id)
    if (!id.success) return badRequest(res, id.error.issues)
    const query = listingsQuerySchema.safeParse(req.query)
    if (!query.success) return badRequest(res, query.error.issues)

    // Every page after the first is a cache hit on the product detail the
    // product page already paid for, so paging re-sorts an in-memory array
    // instead of re-running the median math.
    const product = await productDetail(id.data)
    if (!product) {
      res.status(404).json({ listings: [], nextOffset: null, matchedCount: 0, allIds: [] })
      return
    }
    res.json(paginateListings(product.listings, query.data.filters, query.data.offset))
  })

  // A human looked at this needs_review product and it's fine as-is: clears
  // price_lookup_review_status (see db/schema.sql), no exclusion.
  router.post('/products/:id/mark-reviewed', async (req, res) => {
    const id = productIdParamSchema.safeParse(req.params.id)
    if (!id.success) return badRequest(res, id.error.issues)
    await markProductReviewed(db, id.data)
    cache.invalidate('needs-review', productKey(id.data))
    res.json({ ok: true })
  })

  // Static (categories.parent_id seeding), no per-user input: tagged only so
  // a re-seed can bust it.
  router.get('/categories/tree', async (_req, res) => {
    res.json({ tree: await cache.wrap('sub-category-tree', ['categories'], () => getSubCategoryTree(db)) })
  })

  router.get('/categories/sold-counts', async (_req, res) => {
    const categories = await cache.wrap('sold-counts-by-sub-category', ['sold-listings'], () =>
      getSoldCountsBySubCategory(db),
    )
    res.json({ categories })
  })

  router.get('/review-queue', async (_req, res) => {
    const products = await cache.wrap('products-needing-review', ['needs-review'], () => getProductsNeedingReview(db))
    res.json({ products })
  })

  return router
}
