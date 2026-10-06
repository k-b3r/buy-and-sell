import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import { isQuotaError } from '../../domains/llm-clients'
import type { PriceLookupCandidate, PriceLookupDeps } from './price-lookup'
import { ensureProductPriced } from './price-lookup'

const DEFAULT_PACING_DELAY_MS = 1000

export interface PriceLookupRunDeps extends PriceLookupDeps {
  delay?: DelayFn
}

// Each product is independent - a failure on one is logged and skipped (it
// stays unpriced, so it's a candidate again next lap); only a quota error
// unwinds the whole lap.
// All the actual provider-chain/exclusion logic lives in
// ensureProductPriced (price-lookup.ts), shared with catalog extraction's
// inline per-listing trigger - this loop is just the backfill pass over
// whatever getPriceLookupCandidates still finds unpriced (extraction's own
// inline attempt is now the primary path for brand-new products; this loop
// mainly catches anything that slipped through - a failed inline attempt, a
// listing extracted before the price-lookup worker existed, etc).
export async function runPriceLookup(
  deps: PriceLookupRunDeps,
  products: PriceLookupCandidate[],
  pacingDelayMs = DEFAULT_PACING_DELAY_MS,
): Promise<void> {
  const { clients, db, logger, delay = realDelay } = deps
  logger.info(`${products.length} products to check for retail/secondhand price`)

  for (let i = 0; i < products.length; i++) {
    if (i > 0) await delay(pacingDelayMs)
    const product = products[i]
    try {
      await ensureProductPriced({ clients, db, logger }, product)
    } catch (err) {
      // Fatal-vs-transient rule from llm-clients' error-classification.ts.
      if (isQuotaError(err)) throw err
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`product ${product.id} (${product.base_model}): unexpected error (${message}), skipping this lap`)
    }
  }
}
