import express from 'express'
import type { Router } from 'express'
import type { QueryClient } from '../../platform/storage'
import { getCollectKeywords, replaceCollectKeywords } from './queries'
import { collectKeywordsSchema } from './schemas'

// HTTP edge of the collection feature, mounted by server/index.ts only (the
// module's index.ts does not export it, so workers never load express).
// Same contract the dashboard's /api/collect-keywords had.
export function createCollectionRouter(db: QueryClient): Router {
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

  return router
}
