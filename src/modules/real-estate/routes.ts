import express from 'express'
import type { Router } from 'express'
import type { DbClient } from '../../platform/storage'
import { getRealEstateListings } from './store/listings'
import { REAL_ESTATE_PAGE_SIZE, realEstateQuerySchema } from './schemas'

// HTTP edge of the real-estate feature, mounted by server/index.ts only (the
// module's index.ts does not export it, so workers never load express).
// Same contract the dashboard's /api/real-estate had: one page of listings and
// the next page number (null when this page came back short).
export function createRealEstateRouter(db: DbClient): Router {
  const router = express.Router()

  router.get('/real-estate', async (req, res) => {
    const parsed = realEstateQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message, issues: parsed.error.issues })
      return
    }
    const { filters, page } = parsed.data
    const listings = await getRealEstateListings(db, filters)
    const nextPage = listings.length === REAL_ESTATE_PAGE_SIZE ? page + 1 : null
    res.json({ listings, nextPage })
  })

  return router
}
