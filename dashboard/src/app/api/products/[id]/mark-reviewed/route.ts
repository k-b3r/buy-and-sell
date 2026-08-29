import { NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { getPool } from '@/lib/db'
import { markProductReviewed } from '@/lib/queries'

// A human looked at this needs_review product and it's fine as-is - clears
// price_lookup_review_status back to NULL (see db/schema.sql's comment on
// the column). No exclusion, price-lookup candidates pick it back up.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await markProductReviewed(getPool(), Number(id))

  revalidateTag('needs-review', { expire: 0 })
  revalidateTag(`product:${id}`, { expire: 0 })

  return NextResponse.json({ ok: true })
}
