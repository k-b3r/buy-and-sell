import { NextResponse } from 'next/server'
import { getDeals, getAllSettings, type DealsConfidenceTier } from '@/lib/queries'

const PAGE_SIZE = 30

const CONFIDENCE_TIERS: DealsConfidenceTier[] = ['sold_comps', 'peer_listings', 'llm_estimate']

// Live discount_policy.* settings, not DEFAULT_DISCOUNT_POLICY - the whole
// point of the Settings page (src/platform/settings.ts) is that an operator
// edit takes effect without a redeploy; this page shouldn't be the one place
// that still reads a hardcoded floor.
async function getDiscountPolicyFloors() {
  const settings = await getAllSettings()
  const byKey = new Map(settings.map((s) => [s.key, s.value]))
  return {
    minProfitPesos: byKey.get('discount_policy.min_profit_pesos') ?? 1000,
    minPricePesos: byKey.get('discount_policy.min_price_pesos') ?? 500,
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const search = url.searchParams.get('search')
  const categories = url.searchParams.getAll('category')
  const minProfitParam = url.searchParams.get('minProfit')
  const minTierParam = url.searchParams.get('minTier')
  const maxDaysListedParam = url.searchParams.get('maxDaysListed')
  const addedWithinHoursParam = Number(url.searchParams.get('addedWithinHours'))
  const soldOnly = url.searchParams.get('soldOnly') === 'true'
  const lowConfidenceOnly = url.searchParams.get('lowConfidence') === 'true'
  const offset = Number(url.searchParams.get('offset') ?? '0')

  const minConfidenceTier =
    minTierParam && (CONFIDENCE_TIERS as string[]).includes(minTierParam)
      ? (minTierParam as DealsConfidenceTier)
      : undefined

  const discountPolicy = await getDiscountPolicyFloors()
  const deals = await getDeals(discountPolicy, {
    search: search || undefined,
    categories: categories.length > 0 ? categories : undefined,
    minProfitPesos: minProfitParam ? Number(minProfitParam) : undefined,
    minConfidenceTier,
    maxDaysListed: maxDaysListedParam ? Number(maxDaysListedParam) : undefined,
    addedWithinHours: Number.isInteger(addedWithinHoursParam) && addedWithinHoursParam > 0 ? addedWithinHoursParam : undefined,
    soldOnly,
    lowConfidenceOnly,
    offset,
    limit: PAGE_SIZE,
  })
  const nextOffset = deals.length === PAGE_SIZE ? offset + PAGE_SIZE : null

  return NextResponse.json({ deals, nextOffset })
}
