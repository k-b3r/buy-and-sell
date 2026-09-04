import { NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { excludeProductFromReview } from '@/lib/queries'

// A human agrees with Groq's low-confidence hunch that this needs_review
// product isn't a real priceable product - sets price_lookup_excluded same
// as the automatic paths in applyEligibilityFromEnrichment
// (src/domains/marketplace/storage/products.ts), and clears the review flag
// since exclusion is itself a resolution.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await excludeProductFromReview(Number(id), 'manual_review')

  revalidateTag('needs-review', { expire: 0 })
  revalidateTag('products-list', { expire: 0 })
  revalidateTag(`product:${id}`, { expire: 0 })

  return NextResponse.json({ ok: true })
}
