// listing_photos hints at the separate media-viewer query block Facebook embeds
// alongside the main listing object — same listing id, but no title/price field
// of its own, so it needs its own hint to be recognized as a listing candidate.
const LISTING_KEY_HINTS = ['marketplace_listing_title', 'listing_price', 'custom_title', 'listing_photos']

function looksLikeListing(obj: unknown): obj is Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null) return false
  const record = obj as Record<string, unknown>
  return typeof record.id === 'string' && LISTING_KEY_HINTS.some((key) => key in record)
}

function walk(node: unknown, found: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, found)
    return
  }
  if (typeof node === 'object' && node !== null) {
    if (looksLikeListing(node)) {
      found.push(node as Record<string, unknown>)
    }
    for (const value of Object.values(node)) walk(value, found)
  }
}

export function extractDetailFields(html: string): Record<string, unknown> {
  const found: Record<string, unknown>[] = []
  const scriptRegex = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g
  let match: RegExpExecArray | null
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      walk(parsed, found)
    } catch {
      // not valid JSON in this script block, skip
    }
  }
  if (found.length === 0) return {}
  const richest = found.reduce((a, b) => (Object.keys(b).length > Object.keys(a).length ? b : a))
  // Facebook splits a listing's data across multiple query blocks on the same
  // page (e.g. the photo carousel loads via a separate media-viewer query) —
  // merge every candidate sharing the main object's id instead of discarding
  // them, smallest-first so the richest object's own fields take precedence.
  return found
    .filter((candidate) => candidate.id === richest.id)
    .sort((a, b) => Object.keys(a).length - Object.keys(b).length)
    .reduce((merged, candidate) => ({ ...merged, ...candidate }), {})
}
