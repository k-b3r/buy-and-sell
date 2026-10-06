import type { Logger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import type { VerificationClients } from './discount-verification'
import { precheckDiscountCandidate, verifyDiscountCandidate } from './discount-verification'
import type { DiscountPolicyThresholds, DiscountVerificationCandidate } from './discount-notifications'
import {
  DEFAULT_DISCOUNT_POLICY,
  markDiscountNotificationAttempted,
  markDiscountNotificationVerified,
  rejectDiscountNotification,
} from './discount-notifications'

const DEFAULT_PACING_DELAY_MS = 1000

export interface DiscountVerificationDeps {
  clients: VerificationClients
  db: DbClient
  logger: Logger
  delay?: DelayFn
}

export interface DiscountVerificationOptions {
  paidLimit?: number
  pacingDelayMs?: number
  thresholds?: DiscountPolicyThresholds
}

// Each candidate is independent - a failure judging one (network blip,
// unexpected throw) is logged and skipped via the pending path, never fatal
// to the rest of the lap. verifyDiscountCandidate itself never throws (see
// its own fail-closed design), so this loop's job is purely dispatching its
// outcome to the right storage call.
//
// Two-tier budget: precheckDiscountCandidate (free, synchronous) runs
// against every candidate in the batch, uncapped. Only candidates it clears
// ('proceed') draw against paidLimit - once that's used up, remaining
// proceed-able candidates are left completely untouched (no attempt
// timestamp bumped) so they're still first in line, unpenalized, next lap.
export async function runVerifyDiscountNotifications(
  deps: DiscountVerificationDeps,
  candidates: DiscountVerificationCandidate[],
  options: DiscountVerificationOptions = {},
): Promise<void> {
  const { clients, db, logger, delay = realDelay } = deps
  const {
    paidLimit = Infinity,
    pacingDelayMs = DEFAULT_PACING_DELAY_MS,
    thresholds = DEFAULT_DISCOUNT_POLICY,
  } = options
  logger.info(`${candidates.length} discount notifications pending verification`)

  let paidUsed = 0
  for (const candidate of candidates) {
    const pre = precheckDiscountCandidate(candidate, thresholds)

    if (pre.outcome === 'rejected') {
      await rejectDiscountNotification(db, candidate.id)
      logger.info(`candidate ${candidate.id} (${candidate.base_model}): rejected — ${pre.reasoning}`)
      continue
    }
    if (pre.outcome === 'pending') {
      await markDiscountNotificationAttempted(db, candidate.id)
      logger.warn(`candidate ${candidate.id} (${candidate.base_model}): pending — ${pre.reasoning}`)
      continue
    }

    if (paidUsed >= paidLimit) {
      logger.info(
        `candidate ${candidate.id} (${candidate.base_model}): leaving for next lap, paid-call budget (${paidLimit}) used up this lap`,
      )
      continue
    }
    if (paidUsed > 0) await delay(pacingDelayMs)
    paidUsed++

    try {
      const result = await verifyDiscountCandidate(candidate, clients, thresholds)

      if (result.outcome === 'verified') {
        await markDiscountNotificationVerified(db, candidate.id, {
          discountPercent: result.discountPercent,
          referencePrice: result.referencePrice,
          source: result.source,
          reasoning: result.reasoning,
        })
        logger.info(
          `candidate ${candidate.id} (${candidate.base_model}): verified, ${result.discountPercent}% off via ${result.source}`,
        )
      } else if (result.outcome === 'rejected') {
        await rejectDiscountNotification(db, candidate.id)
        logger.info(`candidate ${candidate.id} (${candidate.base_model}): rejected — ${result.reasoning}`)
      } else {
        await markDiscountNotificationAttempted(db, candidate.id)
        logger.warn(`candidate ${candidate.id} (${candidate.base_model}): pending — ${result.reasoning}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        `candidate ${candidate.id} (${candidate.base_model}): unexpected error (${message}), skipping this lap`,
      )
    }
  }
}
