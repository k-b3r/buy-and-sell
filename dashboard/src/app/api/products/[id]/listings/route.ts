import { NextResponse } from 'next/server'
import { getProductDetailCached } from '@/lib/cachedQueries'
import { paginateListings, parseListingsFilters } from '../../../../products/[id]/listingsFilters'

// getProductDetailCached is a cache hit for every page after the first (see
// listingsFilters.ts's paginateListings comment) - it's the same cached
// product-detail fetch page.tsx's SSR render already paid for, keyed only by
// productId, so paginating filters/sorts/slices an in-memory array rather
// than re-querying or re-computing discount medians per page.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const productId = Number(id)
  const url = new URL(request.url)
  const filters = parseListingsFilters(url.searchParams)
  const offset = Number(url.searchParams.get('offset') ?? '0')

  const product = await getProductDetailCached(productId)
  if (!product) {
    return NextResponse.json({ listings: [], nextOffset: null, matchedCount: 0, allIds: [] }, { status: 404 })
  }

  const page = paginateListings(product.listings, filters, offset)
  return NextResponse.json(page)
}
