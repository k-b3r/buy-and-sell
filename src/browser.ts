import { chromium, type Page } from 'playwright'
import type { PageDriver } from './driver'
import type { GridListing } from './extract/grid'

const DASMARINAS_CAVITE_COORDS = { latitude: 14.3294, longitude: 120.9367 }

export async function launchHeadedBrowser(): Promise<{ close: () => Promise<void>; page: Page }> {
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext({
    locale: 'en-PH',
    timezoneId: 'Asia/Manila',
    geolocation: DASMARINAS_CAVITE_COORDS,
    permissions: ['geolocation'],
  })
  const page = await context.newPage()
  return { page, close: () => browser.close() }
}

export function createBrowserDriver(page: Page): PageDriver {
  return {
    async gotoSearch(query: string, _location: string) {
      // Facebook has no reliable free-text/geolocation location signal for a
      // logged-out session (confirmed: location= param, geolocation permission,
      // and locale/timezone were all ignored, defaulting to a generic US region).
      // What does work is a location *slug* path segment, but only recognized
      // slugs resolve — "manila" is confirmed working and already surfaces
      // Dasmarinas/Cavite-area listings; "dasmarinas" itself is not a
      // recognized slug and falls back to the generic default.
      const url = `https://www.facebook.com/marketplace/manila/search/?query=${encodeURIComponent(query)}&daysSinceListed=30&exact=false`
      await page.goto(url, { waitUntil: 'domcontentloaded' })
    },
    async getGridHtml() {
      return page.content()
    },
    async openListing(listing: GridListing) {
      await page.goto(`https://www.facebook.com/marketplace/item/${listing.id}/`, {
        waitUntil: 'domcontentloaded',
      })
    },
    async getDetailHtml() {
      return page.content()
    },
    async refresh() {
      await page.reload({ waitUntil: 'domcontentloaded' })
    },
    async waitRandom(minMs: number, maxMs: number) {
      const delay = minMs + Math.random() * (maxMs - minMs)
      await page.waitForTimeout(delay)
    },
  }
}
