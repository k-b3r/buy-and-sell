import { z } from 'zod'
import type { CollectKeyword } from './types'

const NOT_AN_ARRAY = 'keywords must be a non-empty array'

type Normalized = { keywords: CollectKeyword[] } | { error: string }

// Full-list replace, so the whole list is checked here: collect must never run
// a --cycle lap with zero search queries. An empty save is rejected rather than
// silently falling through to DEFAULT_COLLECT_KEYWORDS - an operator who cleared
// every row almost certainly meant to type a replacement, not reset to defaults.
// Same for a list with every keyword toggled off: loadCollectKeywords would fall
// back to the defaults, the opposite of what was asked.
function normalize(raw: unknown[]): Normalized {
  const keywords: CollectKeyword[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const entry = item as { keyword?: unknown; enabled?: unknown } | null
    if (typeof entry?.keyword !== 'string' || typeof entry.enabled !== 'boolean') {
      return { error: 'each keyword must be { keyword: string, enabled: boolean }' }
    }
    const keyword = entry.keyword.trim().toLowerCase()
    if (keyword === '') return { error: 'keyword cannot be blank' }
    if (seen.has(keyword)) continue
    seen.add(keyword)
    keywords.push({ keyword, enabled: entry.enabled })
  }
  if (!keywords.some((k) => k.enabled)) return { error: 'at least one keyword must be enabled' }
  return { keywords }
}

export const collectKeywordsSchema = z
  .array(z.unknown(), { error: NOT_AN_ARRAY })
  .min(1, NOT_AN_ARRAY)
  .transform((raw, ctx) => {
    const result = normalize(raw)
    if ('error' in result) {
      ctx.issues.push({ code: 'custom', message: result.error, input: raw })
      return z.NEVER
    }
    return result.keywords
  })

// ?productId on save/unsave names the product whose cached detail embeds this
// listing's saved flag, so the route can drop that cache entry without a
// lookup round trip. Absent for a listing with no product.
export const saveListingQuerySchema = z.object({
  productId: z
    .string()
    .regex(/^[1-9]\d*$/, 'productId must be a positive integer')
    .transform(Number)
    .optional(),
})
