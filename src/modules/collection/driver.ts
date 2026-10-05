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
