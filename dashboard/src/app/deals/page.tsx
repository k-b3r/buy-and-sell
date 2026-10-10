import { getDeals, getAllSettings } from '@/lib/queries'
import DealsClient from './DealsClient'

const PAGE_SIZE = 30

async function getDiscountPolicyFloors() {
  const settings = await getAllSettings()
  const byKey = new Map(settings.map((s) => [s.key, s.value]))
  return {
    minProfitPesos: byKey.get('discount_policy.min_profit_pesos') ?? 1000,
    minPricePesos: byKey.get('discount_policy.min_price_pesos') ?? 500,
  }
}

// Ranked-by-profit view of active listings -
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
