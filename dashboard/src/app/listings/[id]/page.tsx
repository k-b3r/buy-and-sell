import { notFound } from 'next/navigation'
import { getListingDetailCached } from '@/lib/cachedQueries'
import ListingDetailContent from './ListingDetailContent'

// Live data - prerendering would pin it to build time, and would also make
// the build depend on server/ being reachable from the build container (see
// analytics/page.tsx). Freshness is cachedQueries.ts's job, not the build's.
export const dynamic = 'force-dynamic'

export default async function ListingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ back?: string }>
}) {
  const { id } = await params
  const { back } = await searchParams
  const listing = await getListingDetailCached(id)
  if (!listing) notFound()

  return <ListingDetailContent listing={listing} back={back} />
}
