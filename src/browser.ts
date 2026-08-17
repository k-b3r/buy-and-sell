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
      // No `location=` param: Facebook's own default (via geolocation permission
      // granted on the context) resolves the correct area. Passing a free-text
      // location string here was confirmed to override that correct default
      // with a generic fallback region instead.
      const url = `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(query)}`
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
