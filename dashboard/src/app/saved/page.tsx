import { getPool } from '@/lib/db'
import { getSavedListingsCached } from '@/lib/cachedQueries'
import SavedListingsClient from './SavedListingsClient'

export default async function SavedPage() {
  const listings = await getSavedListingsCached(getPool())

  return (
    <div>
      <h1>Saved listings</h1>
      <SavedListingsClient initialListings={listings} />
    </div>
  )
}
