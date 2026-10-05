import type { GridListing } from './extract/grid'
import type { PageCursor } from './paginate'

export interface PageDriver {
  gotoSearch(query: string, daysSinceListed: number): Promise<void>
  getGridHtml(): Promise<string>
  openListing(listing: GridListing): Promise<void>
  getDetailHtml(): Promise<string>
  refresh(): Promise<void>
  waitRandom(minMs: number, maxMs: number): Promise<void>
  fetchNextPage(cursor: PageCursor, lsd: string, query: string): Promise<string>
}

// A launched browser's driver plus the handle that tears the browser down.
export interface BrowserDriver {
  driver: PageDriver
  close: () => Promise<void>
}

export interface BrowserProxy {
  server: string
  username?: string
  password?: string
}

// launchBrowserDriver's shape (browser.ts), injected where tests swap in a fake browser.
export type DriverFactory = (proxy?: BrowserProxy) => Promise<BrowserDriver>

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
