import { NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { getPool } from '@/lib/db'
import { saveListing, unsaveListing } from '@/lib/queries'

// Dashboard-wide bookmark toggle (see db/schema.sql's saved_listings) - no
// per-user scoping, already gated by proxy.ts's blanket auth check same as
// every other route here. productId is passed as a query param rather than
// looked up here, since the client already has it from ListingDetail/
// ProductListingSummary - avoids an extra round trip just to invalidate the
// right cache tag.
function productTag(url: URL): string | null {
  const productId = url.searchParams.get('productId')
  return productId ? `product:${productId}` : null
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await saveListing(getPool(), id)

  revalidateTag(`listing:${id}`, { expire: 0 })
  revalidateTag('saved-listings', { expire: 0 })
  const tag = productTag(new URL(request.url))
  if (tag) revalidateTag(tag, { expire: 0 })

  return NextResponse.json({ saved: true })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await unsaveListing(getPool(), id)

  revalidateTag(`listing:${id}`, { expire: 0 })
  revalidateTag('saved-listings', { expire: 0 })
  const tag = productTag(new URL(request.url))
  if (tag) revalidateTag(tag, { expire: 0 })

  return NextResponse.json({ saved: false })
}
