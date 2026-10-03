import { NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { setManualPrice, markProductReviewed } from '@/lib/queries'

// A human typed in a retail/secondhand price for a needs_review product -
// setManualPrice ranks it above every automated source (see
// NEW_PRICE_LATERAL/SECONDHAND_PRICE_LATERAL in lib/queries.ts). Also clears
// price_lookup_review_status same as mark-reviewed/exclude: providing a
// price is itself the human review this page exists for, per direct
// instruction (2026-08-29) - don't make them click twice.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await request.json()
  const { kind, priceLow, priceHigh } = body as { kind?: string; priceLow?: number; priceHigh?: number }

  if (kind !== 'new' && kind !== 'secondhand') {
    return NextResponse.json({ error: 'kind must be "new" or "secondhand"' }, { status: 400 })
  }
  if (
    typeof priceLow !== 'number' ||
    typeof priceHigh !== 'number' ||
    !Number.isFinite(priceLow) ||
    !Number.isFinite(priceHigh)
  ) {
    return NextResponse.json({ error: 'priceLow/priceHigh must be numbers' }, { status: 400 })
  }
  if (priceLow <= 0 || priceHigh <= 0 || priceLow > priceHigh) {
    return NextResponse.json({ error: 'priceLow must be positive and not greater than priceHigh' }, { status: 400 })
  }

  const productId = Number(id)
  await setManualPrice(productId, kind, priceLow, priceHigh)
  await markProductReviewed(productId)

  revalidateTag('needs-review', { expire: 0 })
  revalidateTag('products-list', { expire: 0 })
  revalidateTag(`product:${id}`, { expire: 0 })

  return NextResponse.json({ ok: true })
}
