import type { DiscountNotification } from './queries'

export interface NewToastsResult {
  toasts: DiscountNotification[]
  nextBaselineIso: string | null
}

// Turns a fresh /api/notifications poll into "what's actually new since last
// time" for the toast layer. A null baseline means "first poll ever" -
// deliberately toasts nothing, just establishes the newest created_at seen so
// far, so opening the dashboard doesn't replay the whole unread backlog as a
// pile of toasts. Every poll after that toasts only rows strictly newer than
// the baseline (oldest first, so multiple arrivals stack in the order they
// happened), then advances the baseline to the newest row seen.
export function selectNewToasts(notifications: DiscountNotification[], baselineIso: string | null): NewToastsResult {
  if (notifications.length === 0) return { toasts: [], nextBaselineIso: baselineIso }

  const newestIso = notifications.reduce(
    (max, n) => (n.created_at > max ? n.created_at : max),
    notifications[0].created_at,
  )

  if (baselineIso === null) return { toasts: [], nextBaselineIso: newestIso }

  const toasts = notifications
    .filter((n) => n.created_at > baselineIso)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))

  return { toasts, nextBaselineIso: newestIso > baselineIso ? newestIso : baselineIso }
}
