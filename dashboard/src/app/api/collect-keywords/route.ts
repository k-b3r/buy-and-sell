import { NextResponse } from 'next/server'
import { getPool } from '@/lib/db'
import { getCollectKeywords, replaceCollectKeywords } from '@/lib/queries'

export async function GET() {
  const keywords = await getCollectKeywords(getPool())
  return NextResponse.json({ keywords })
}

// Full-list replace, not add/remove-one - matches the UI's row-editor
// (type to add a row, click x to remove one, Save sends the whole list).
// collect must never run a --cycle lap with zero search queries, so an
// empty save is rejected here rather than silently falling through to
// DEFAULT_COLLECT_KEYWORDS - an operator who cleared every row almost
// certainly meant to type a replacement, not reset to defaults.
export async function PUT(request: Request) {
  const body = await request.json()
  const keywords = (body as { keywords?: unknown }).keywords

  if (!Array.isArray(keywords) || keywords.length === 0) {
    return NextResponse.json({ error: 'keywords must be a non-empty array' }, { status: 400 })
  }

  const cleaned: string[] = []
  const seen = new Set<string>()
  for (const raw of keywords) {
    if (typeof raw !== 'string') {
      return NextResponse.json({ error: 'each keyword must be a string' }, { status: 400 })
    }
    const trimmed = raw.trim().toLowerCase()
    if (trimmed === '') {
      return NextResponse.json({ error: 'keyword cannot be blank' }, { status: 400 })
    }
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    cleaned.push(trimmed)
  }

  await replaceCollectKeywords(getPool(), cleaned)
  return NextResponse.json({ ok: true })
}
