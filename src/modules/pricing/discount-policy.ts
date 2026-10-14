// Discount detection and verification thresholds, shared by the decision
// (discount-notifications.ts), the verification loop and the store's
// candidate query default.
export interface DiscountPolicyThresholds {
  highDiscountThresholdPercent: number
  minProfitPesos: number
  minPricePesos: number
}

// Operator-tunable via the dashboard Settings page (discount_policy.* keys,
// src/platform/settings.ts) - callers load live values with loadSettings
// and pass them through explicitly; these are just the fallback defaults
// (also the settings table's seed values, db/schema.sql) for callers that
// don't pass thresholds at all (e.g. direct test calls).
export const DEFAULT_DISCOUNT_POLICY: DiscountPolicyThresholds = {
  // Bar for a bell-worthy notification, deliberately higher than the
  // dashboard's 10% discount-badge floor (DISCOUNT_SUMMARY_LATERAL) - a
  // notification is a stronger claim than a badge, per direct instruction.
  highDiscountThresholdPercent: 30,
  // A high % on a cheap item isn't a meaningful opportunity (₱150 item at
  // 50% off is only ₱75 profit) - the absolute peso gap must also clear
  // this bar, independent of the percent threshold.
  minProfitPesos: 1000,
  // Below this, the item isn't worth chasing regardless of discount%/profit
  // math - also the regime where a vague base_model (Bikini, Books, Boys'
  // Clothes) gets matched against a wildly wrong reference price and
  // produces a noisy, not-actually-real "deal" (confirmed live 2026-08-31:
  // several ₱50-150 listings cleared both the discount% and profit bars on
  // stale reference prices alone). Deliberately well below minProfitPesos's
  // own ₱1,000 bar, not equal to it - a ₱500 item reselling at ₱1,500 is a
  // real ₱1,000-profit flip and shouldn't be excluded just for being cheap
  // up front; this floor exists to catch junk-tier noise, not to require
  // the item itself be expensive.
  minPricePesos: 500,
}
