import express from 'express'
import type { Router } from 'express'
import { getAllSettings, updateSettings } from '../../src/platform/settings'
import { settingsUpdatesSchema } from '../../src/platform/settings-schema'
import type { QueryClient } from '../../src/platform/storage'

// Operator-tunable knobs for the workers and discount policy. Same contract
// the dashboard's /api/settings had: reads return { settings }, a PATCH takes
// { updates } and fails whole with { error } on the first invalid entry.
export function createSettingsRouter(db: QueryClient): Router {
  const router = express.Router()

  router.get('/settings', async (_req, res) => {
    res.json({ settings: await getAllSettings(db) })
  })

  router.patch('/settings', async (req, res) => {
    const parsed = settingsUpdatesSchema.safeParse((req.body as { updates?: unknown } | undefined)?.updates)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message })
      return
    }
    await updateSettings(db, parsed.data)
    res.json({ ok: true })
  })

  return router
}
