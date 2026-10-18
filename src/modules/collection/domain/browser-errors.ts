// "Page crashed" is the browser tab itself dying; "Target page, context or
// browser has been closed" is Playwright's error when the browser/context
// handle is gone entirely - confirmed live 2026-09-03 via
// buy-and-sell-server.service's KillMode=control-group SIGTERMing a
// still-running collect worker's browser as collateral damage from an
// unrelated server restart. Both leave the existing driver permanently
// unusable, so both need a fresh browser, not just a retry.
const BROWSER_UNUSABLE_ERROR_SUBSTRINGS = ['Page crashed', 'Target page, context or browser has been closed']

export function isBrowserUnusableError(err: unknown): boolean {
  return err instanceof Error && BROWSER_UNUSABLE_ERROR_SUBSTRINGS.some((s) => err.message.includes(s))
}
