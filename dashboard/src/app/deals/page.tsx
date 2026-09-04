import { getDeals, getAllSettings } from '@/lib/queries'
import DealsClient from './DealsClient'

// Without this, Next statically generates this page once at build time (it
// takes no searchParams/cookies, the only signals Next otherwise uses to
// infer a page needs per-request rendering) and freezes today's ranking
// forever until the next deploy - the exact opposite of "what's a good deal
// right now" this page exists for. Confirmed live 2026-09-02: `next build`
// marked /deals "○ (Static)" without this.
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 30

async function getDiscountPolicyFloors() {
  const settings = await getAllSettings()
  const byKey = new Map(settings.map((s) => [s.key, s.value]))
  return {
    minProfitPesos: byKey.get('discount_policy.min_profit_pesos') ?? 1000,
    minPricePesos: byKey.get('discount_policy.min_price_pesos') ?? 500,
  }
}

// Ranked-by-profit view of active listings (see SESSION_RESUME.md's spec) -
// not cached (unlike getProductSummariesCached etc.): this page's whole
// point is to surface the current best opportunities, a stale copy of
// "current" is actively misleading in a way a stale product catalog isn't.
export default async function DealsPage() {
  const discountPolicy = await getDiscountPolicyFloors()
  const [deals, lowConfidenceDeals] = await Promise.all([
    getDeals(discountPolicy, { limit: PAGE_SIZE }),
    getDeals(discountPolicy, { lowConfidenceOnly: true, limit: PAGE_SIZE }),
  ])
  const nextOffset = deals.length === PAGE_SIZE ? PAGE_SIZE : null
  const lowConfidenceNextOffset = lowConfidenceDeals.length === PAGE_SIZE ? PAGE_SIZE : null

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
