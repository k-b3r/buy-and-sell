import { NextResponse } from 'next/server'
import { getCollectKeywords, replaceCollectKeywords, type CollectKeyword } from '@/lib/queries'

export async function GET() {
  const keywords = await getCollectKeywords()
  return NextResponse.json({ keywords })
}

// Full-list replace, not add/remove-one - matches the UI's row-editor
// (type to add a row, click x to remove one, Save sends the whole list).
// collect must never run a --cycle lap with zero search queries, so an
// empty save is rejected here rather than silently falling through to
// DEFAULT_COLLECT_KEYWORDS - an operator who cleared every row almost
// certainly meant to type a replacement, not reset to defaults. Same for a
// list with every keyword toggled off - loadCollectKeywords would silently
// fall back to the defaults, the opposite of what was asked.
export async function PUT(request: Request) {
  const body = await request.json()
  const keywords = (body as { keywords?: unknown }).keywords

  if (!Array.isArray(keywords) || keywords.length === 0) {
    return NextResponse.json({ error: 'keywords must be a non-empty array' }, { status: 400 })
  }

  const cleaned: CollectKeyword[] = []
  const seen = new Set<string>()
  for (const raw of keywords) {
    const entry = raw as { keyword?: unknown; enabled?: unknown } | null
    if (typeof entry?.keyword !== 'string' || typeof entry.enabled !== 'boolean') {
      return NextResponse.json({ error: 'each keyword must be { keyword: string, enabled: boolean }' }, { status: 400 })
    }
    const trimmed = entry.keyword.trim().toLowerCase()
    if (trimmed === '') {
      return NextResponse.json({ error: 'keyword cannot be blank' }, { status: 400 })
    }
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    cleaned.push({ keyword: trimmed, enabled: entry.enabled })
  }

  if (!cleaned.some((k) => k.enabled)) {
    return NextResponse.json({ error: 'at least one keyword must be enabled' }, { status: 400 })
  }

  await replaceCollectKeywords(cleaned)
  return NextResponse.json({ ok: true })
}
