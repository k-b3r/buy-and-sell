import { notFound } from 'next/navigation'
import { getPool } from '@/lib/db'
import { getListingDetailCached } from '@/lib/cachedQueries'
import ListingDetailContent from './ListingDetailContent'

export default async function ListingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ back?: string }>
}) {
  const { id } = await params
  const { back } = await searchParams
  const listing = await getListingDetailCached(getPool(), id)
  if (!listing) notFound()

  return <ListingDetailContent listing={listing} back={back} />
}
