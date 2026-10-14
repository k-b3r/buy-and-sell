import { z } from 'zod'

// Floors per key, replacing a blanket "≥ 0". Count-based knobs (batch sizes,
// limits, attempts) floor at 1, not 0 - several feed a `for (...; i += BATCH_SIZE)`
// -shaped loop that hangs forever at 0. Generic *_ms knobs floor at 1000ms.
// The FB-facing knobs (collect/check_listings pacing + loop delay) get a
// higher floor - these throttle live requests against Facebook, and a rushed
// low value risks the exact rate-limit/ban scenario this project already
// treats as a standing concern. settings-schema.test.ts keeps this list in
// step with SETTING_DEFAULTS.
export const SETTING_FLOORS: Record<string, number> = {
  'collect.max_items_default': 1,
  'collect.soft_wall_timeout_ms': 1000,
  'collect.pacing_min_ms': 2000,
  'collect.pacing_max_ms': 2000,
  'collect.loop_delay_ms': 10000,
  'collect.re_keywords_enabled': 0,
  'collect.re_every_n_laps': 1,
  'collect.re_max_items': 1,

  'check_listings.loop_delay_ms': 10000,
  'check_listings.limit_default': 1,
  'check_listings.soft_wall_timeout_ms': 1000,
  'check_listings.pacing_min_ms': 2000,
  'check_listings.pacing_max_ms': 2000,
  'check_listings.re_recheck_min_days': 0,
  'check_listings.deals_priority_enabled': 0,
  'check_listings.deals_recheck_min_hours': 1,

  'extract_products.max_attempts': 1,
  'extract_products.retry_base_delay_ms': 1000,
  'extract_products.loop_delay_ms': 1000,
  'extract_products.batch_size': 1,
  'extract_products.inter_batch_delay_ms': 1000,

  'enrich_products.batch_size': 1,
  'enrich_products.loop_delay_ms': 1000,
  'enrich_products.max_attempts': 1,
  'enrich_products.retry_delay_ms': 1000,

  'price_lookup.lap_limit_default': 1,
  'price_lookup.loop_delay_ms': 1000,
  'price_lookup.pacing_delay_ms': 1000,

  'enrich_listing_prices.batch_size': 1,
  'enrich_listing_prices.loop_delay_ms': 1000,

  'extract_real_estate.batch_size': 1,
  'extract_real_estate.loop_delay_ms': 1000,

  'verify_discount.lap_limit_default': 1,
  'verify_discount.fetch_batch_size': 1,
  'verify_discount.loop_delay_ms': 1000,
  'verify_discount.pacing_delay_ms': 1000,

  'discount_policy.high_discount_threshold_percent': 0,
  'discount_policy.min_profit_pesos': 0,
  'discount_policy.min_price_pesos': 0,
  'discount_policy.gemini_daily_grounding_cap': 1,

  'llm.gateway_enabled': 0,
  'llm.direct_fallback_enabled': 0,

  'pricing.exclusions_ui_enabled': 0,
}

const PERCENT_KEYS = new Set(['discount_policy.high_discount_threshold_percent'])
const MAX_PERCENT = 100

// A min > max would make the workers' waitRandom(min, max) call misbehave.
// Only enforceable when both keys of a pair are in the same PATCH - the
// dashboard always saves a whole worker section at once, so both arrive together.
const PACING_PAIRS: [string, string][] = [
  ['collect.pacing_min_ms', 'collect.pacing_max_ms'],
  ['check_listings.pacing_min_ms', 'check_listings.pacing_max_ms'],
]

export interface SettingUpdate {
  key: string
  value: number
}

const NOT_AN_ARRAY = 'updates must be a non-empty array'

// The first issue's message is what the dashboard shows the operator.
function updateProblem(update: unknown): string | null {
  const { key, value } = (update ?? {}) as { key?: unknown; value?: unknown }
  if (typeof key !== 'string' || typeof value !== 'number' || !Number.isInteger(value)) {
    return `invalid update: ${JSON.stringify(update)}`
  }
  const floor = SETTING_FLOORS[key]
  if (floor === undefined) return `unknown setting key "${key}"`
  if (value < floor) return `${key} must be >= ${floor}`
  if (PERCENT_KEYS.has(key) && value > MAX_PERCENT) return `${key} must be <= ${MAX_PERCENT}`
  return null
}

export const settingsUpdatesSchema = z
  .array(z.unknown(), { error: NOT_AN_ARRAY })
  .min(1, NOT_AN_ARRAY)
  .superRefine((raw, ctx) => {
    for (const update of raw) {
      const problem = updateProblem(update)
      if (problem) {
        ctx.addIssue({ code: 'custom', message: problem })
        return
      }
    }
    const byKey = new Map((raw as SettingUpdate[]).map((u) => [u.key, u.value]))
    for (const [minKey, maxKey] of PACING_PAIRS) {
      const min = byKey.get(minKey)
      const max = byKey.get(maxKey)
      if (min !== undefined && max !== undefined && min > max) {
        ctx.addIssue({ code: 'custom', message: `${minKey} must be <= ${maxKey}` })
        return
      }
    }
  })
  .transform((raw) => raw as SettingUpdate[])
