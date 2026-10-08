import { NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { includeInPricing, isExclusionsUiEnabled } from '@/lib/queries'

// The undo for a pricing exclusion (BUY-36): a failed-search reason is
// retried, a verdict is overridden (src/modules/pricing/exclusion.ts's
// includeInPricing). Same cache busting as the exclude route next door.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isExclusionsUiEnabled())) return NextResponse.json({ error: 'disabled' }, { status: 404 })
  const { id } = await params
  const productId = Number(id)
  if (!Number.isInteger(productId) || productId <= 0) {
    return NextResponse.json({ error: 'invalid product id' }, { status: 400 })
  }
  await includeInPricing(productId)

  revalidateTag('products-list', { expire: 0 })
  revalidateTag(`product:${id}`, { expire: 0 })

  return NextResponse.json({ ok: true })
}
