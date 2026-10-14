import { getDeals } from '@/lib/queries'
import DealsClient from './DealsClient'

// Without this, Next statically generates this page once at build time (it
// takes no searchParams/cookies, the only signals Next otherwise uses to
// infer a page needs per-request rendering) and freezes today's ranking
// forever until the next deploy - the exact opposite of "what's a good deal
// right now" this page exists for. Confirmed live 2026-09-02: `next build`
// marked /deals "○ (Static)" without this.
export const dynamic = 'force-dynamic'

// Ranked-by-profit view of active listings -
// not cached (unlike the catalog reads the server caches): this page's whole
// point is to surface the current best opportunities, a stale copy of
// "current" is actively misleading in a way a stale product catalog isn't.
export default async function DealsPage() {
  const [{ deals, nextOffset }, { deals: lowConfidenceDeals, nextOffset: lowConfidenceNextOffset }] = await Promise.all(
    [getDeals(), getDeals({ lowConfidenceOnly: true })],
  )

  return (
    <div>
      <h1>Deals</h1>
      <DealsClient
        initialDeals={deals}
        initialNextOffset={nextOffset}
        initialLowConfidenceDeals={lowConfidenceDeals}
        initialLowConfidenceNextOffset={lowConfidenceNextOffset}
      />
    </div>
  )
}
