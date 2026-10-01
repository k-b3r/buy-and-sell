import { notFound } from 'next/navigation'
import { getListingDetailCached } from '@/lib/cachedQueries'
import Modal from '../../../Modal'
import ListingDetailContent from '../../../listings/[id]/ListingDetailContent'

// Live data - prerendering would pin it to build time, and would also make
// the build depend on server/ being reachable from the build container (see
// analytics/page.tsx). Freshness is cachedQueries.ts's job, not the build's.
export const dynamic = 'force-dynamic'

export default async function ListingModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const listing = await getListingDetailCached(id)
  if (!listing) notFound()

  return (
    <Modal currentId={listing.id}>
      <ListingDetailContent listing={listing} showBackLink={false} />
    </Modal>
  )
}
