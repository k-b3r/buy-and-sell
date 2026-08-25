import { notFound } from 'next/navigation'
import { getPool } from '@/lib/db'
import { getListingDetailCached } from '@/lib/cachedQueries'
import ListingDetailContent from './ListingDetailContent'

export default async function ListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const listing = await getListingDetailCached(getPool(), id)
  if (!listing) notFound()

  return <ListingDetailContent listing={listing} />
}
