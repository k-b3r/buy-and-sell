// Floors per key, replacing a blanket "≥ 0" - kept dashboard-side, same
// hand-synced precedent as admin/logs' WORKER_DESCRIPTIONS (dashboard/ and
// the worker scripts are separate packages with no shared import path).
// Count-based knobs (batch sizes, limits, attempts) floor at 1, not 0 -
// several feed a `for (...; i += BATCH_SIZE)`-shaped loop that hangs
// forever (infinite loop) at 0. Generic *_ms knobs floor at 1000ms. The
// FB-facing knobs (collect/check_listings pacing + loop delay) get a higher
// floor - these throttle live requests against Facebook, and a rushed low
// value risks the exact rate-limit/ban scenario this project already treats
// as a standing concern.
const SETTING_FLOORS: Record<string, number> = {
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

// A min > max would make the workers' waitRandom(min, max) call misbehave.
// Only enforceable when both keys of a pair are present in the same PATCH -
// the dashboard UI always saves a whole worker section at once (not
// per-field), so both members of a pair are always submitted together.
const PACING_PAIRS: [string, string][] = [
  ['collect.pacing_min_ms', 'collect.pacing_max_ms'],
  ['check_listings.pacing_min_ms', 'check_listings.pacing_max_ms'],
]

export interface SettingUpdate {
  key: string
  value: number
}

export type SettingsUpdatesValidation = { updates: SettingUpdate[] } | { error: string }

function validateUpdate(update: unknown): SettingUpdate | { error: string } {
  const { key, value } = (update ?? {}) as { key?: unknown; value?: unknown }
  if (typeof key !== 'string' || typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { error: `invalid update: ${JSON.stringify(update)}` }
  }
  const floor = SETTING_FLOORS[key]
  if (floor === undefined) {
    return { error: `unknown setting key "${key}"` }
  }
  if (value < floor) {
    return { error: `${key} must be >= ${floor}` }
  }
  if (PERCENT_KEYS.has(key) && value > 100) {
    return { error: `${key} must be <= 100` }
  }
  return { key, value }
}

export function validateSettingsUpdates(updates: unknown): SettingsUpdatesValidation {
  if (!Array.isArray(updates) || updates.length === 0) {
    return { error: 'updates must be a non-empty array' }
  }

  const parsed: SettingUpdate[] = []
  const byKey = new Map<string, number>()

  for (const update of updates) {
    const result = validateUpdate(update)
    if ('error' in result) return result
    parsed.push(result)
    byKey.set(result.key, result.value)
  }

  for (const [minKey, maxKey] of PACING_PAIRS) {
    const min = byKey.get(minKey)
    const max = byKey.get(maxKey)
    if (min !== undefined && max !== undefined && min > max) {
      return { error: `${minKey} must be <= ${maxKey}` }
    }
  }

  return { updates: parsed }
}
