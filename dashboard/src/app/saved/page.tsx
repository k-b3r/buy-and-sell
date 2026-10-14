import { getSavedListings } from '@/lib/queries'
import SavedListingsClient from './SavedListingsClient'

// Live data - prerendering would pin it to build time, and would also make
// the build depend on server/ being reachable from the build container (see
// analytics/page.tsx). Freshness is the server's cache job, not the build's.
export const dynamic = 'force-dynamic'

export default async function SavedPage() {
  const listings = await getSavedListings()

  return (
    <div>
      <h1>Saved listings</h1>
      <SavedListingsClient initialListings={listings} />
    </div>
  )
}
