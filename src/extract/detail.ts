const LISTING_KEY_HINTS = ['marketplace_listing_title', 'listing_price', 'custom_title']

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
  return found.reduce((richest, candidate) =>
    Object.keys(candidate).length > Object.keys(richest).length ? candidate : richest,
  )
}
