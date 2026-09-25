import { NextResponse } from 'next/server'
import { getRealEstateListings } from '@/lib/queries'
import { parseRealEstateFilters, REAL_ESTATE_PAGE_SIZE } from '@/lib/realEstate'

// Next page for the /real-estate grid's infinite scroll - same filters as the
// page itself (parseRealEstateFilters), just a later page.
export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams.entries())
  const { filters, page } = parseRealEstateFilters(params)
  const listings = await getRealEstateListings(filters)
  const nextPage = listings.length === REAL_ESTATE_PAGE_SIZE ? page + 1 : null
  return NextResponse.json({ listings, nextPage })
}
