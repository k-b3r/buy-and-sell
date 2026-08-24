import { notFound } from 'next/navigation'
import { getPool } from '@/lib/db'
import { getListingDetail } from '@/lib/queries'
import Modal from '../../../Modal'
import ListingDetailContent from '../../../listings/[id]/ListingDetailContent'

export default async function ListingModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const listing = await getListingDetail(getPool(), id)
  if (!listing) notFound()

  return (
    <Modal currentId={listing.id}>
      <ListingDetailContent listing={listing} showBackLink={false} />
    </Modal>
  )
}
