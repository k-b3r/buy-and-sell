import express from 'express'
import type { Router } from 'express'
import type { QueryClient } from '../../platform/storage'
import { getListingDetail } from './listing-detail'
import {
  getCollectKeywords,
  getSavedListings,
  replaceCollectKeywords,
  saveListing,
  unsaveListing,
} from './store/dashboard'
import { collectKeywordsSchema, saveListingQuerySchema } from './schemas'

// The slice of the server's cache (server/cache.ts) this router needs. Declared
// here because src/ cannot import server/; the server's Cache fits it as is.
export interface RouteCache {
  wrap<T>(key: string, tags: string[], load: () => Promise<T>): Promise<T>
  invalidate(...tags: string[]): void
}

// HTTP edge of the collection feature, mounted by server/index.ts only (the
// module's index.ts does not export it, so workers never load express).
// Same contract the dashboard's /api/collect-keywords and
// /api/listings/:id/save had.
export function createCollectionRouter(db: QueryClient, cache: RouteCache): Router {
  const router = express.Router()

  router.get('/collect-keywords', async (_req, res) => {
    res.json({ keywords: await getCollectKeywords(db) })
  })

  router.put('/collect-keywords', async (req, res) => {
    const parsed = collectKeywordsSchema.safeParse((req.body as { keywords?: unknown } | undefined)?.keywords)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message })
      return
    }
    await replaceCollectKeywords(db, parsed.data)
    res.json({ ok: true })
  })

  // Wrapped, so an unknown listing is a 200 with { listing: null } rather than
  // a 404 the dashboard's fetch helper would throw on.
  router.get('/listings/:id', async (req, res) => {
    const { id } = req.params
    const listing = await cache.wrap(`listing:${id}`, [`listing:${id}`], () => getListingDetail(db, id))
    res.json({ listing })
  })

  router.get('/saved-listings', async (_req, res) => {
    const listings = await cache.wrap('saved-listings', ['saved-listings'], () => getSavedListings(db))
    res.json({ listings })
  })

  // The product tag is named by the client (it already has the product id) so
  // the product detail, which embeds this listing's saved flag, is dropped
  // without a lookup.
  async function toggleSaved(req: express.Request, res: express.Response, saved: boolean) {
    const query = saveListingQuerySchema.safeParse(req.query)
    if (!query.success) {
      res.status(400).json({ error: query.error.issues[0].message })
      return
    }
    const id = req.params.id as string
    await (saved ? saveListing(db, id) : unsaveListing(db, id))

    const tags = [`listing:${id}`, 'saved-listings']
    if (query.data.productId !== undefined) tags.push(`product:${query.data.productId}`)
    cache.invalidate(...tags)
    res.json({ saved })
  }

  router.post('/listings/:id/save', (req, res) => toggleSaved(req, res, true))
  router.delete('/listings/:id/save', (req, res) => toggleSaved(req, res, false))

  return router
}
