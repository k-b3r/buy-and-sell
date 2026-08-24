import { notFound } from 'next/navigation'
import { getPool } from '@/lib/db'
import { getListingDetail } from '@/lib/queries'
import ListingDetailContent from './ListingDetailContent'

export default async function ListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const listing = await getListingDetail(getPool(), id)
  if (!listing) notFound()

  return <ListingDetailContent listing={listing} />
}
