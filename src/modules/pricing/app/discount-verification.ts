import { DEFAULT_DISCOUNT_POLICY } from '../domain/discount-policy'
import { parseVerificationResponse, precheckDiscountCandidate } from '../domain/discount-verification'
import { buildVerificationPrompt, VERIFICATION_RESPONSE_SCHEMA } from '../prompts/discount-verification.prompt'
import { fetchFreshMarketContext } from '../clients/market-context'
import type {
  DiscountPolicyThresholds,
  DiscountVerificationCandidate,
  VerificationClients,
  VerificationOutcome,
} from '../types'

export async function verifyDiscountCandidate(
  candidate: DiscountVerificationCandidate,
  clients: VerificationClients,
  thresholds: DiscountPolicyThresholds = DEFAULT_DISCOUNT_POLICY,
): Promise<VerificationOutcome> {
  const pre = precheckDiscountCandidate(candidate, thresholds)
  if (pre.outcome !== 'proceed') return pre

  const context = await fetchFreshMarketContext(candidate, clients)
  if (context === null) {
    return { outcome: 'pending', reasoning: 'No fresh market data available from any provider.' }
  }

  let raw: unknown
  try {
    raw = await clients.openrouter.generateJson(
      buildVerificationPrompt(candidate, context.text, thresholds),
      VERIFICATION_RESPONSE_SCHEMA,
    )
  } catch {
    return { outcome: 'pending', reasoning: 'Verification judgement call failed.' }
  }

  const parsed = parseVerificationResponse(raw)
  if (parsed === null) {
    return { outcome: 'pending', reasoning: 'Verification judgement returned a malformed response.' }
  }

  if (!parsed.stillDiscounted || parsed.conditionExplainsLowPrice || !parsed.meetsProfitBar) {
    return { outcome: 'rejected', reasoning: parsed.reasoning }
  }

  const referencePrice = parsed.freshPriceLow
  const discountPercent = Math.round(((referencePrice - candidate.price_amount) / referencePrice) * 100)
  return { outcome: 'verified', discountPercent, referencePrice, source: context.source, reasoning: parsed.reasoning }
}
