import { chromium, type Page } from 'playwright'
import type { PageDriver } from './driver'
import type { GridListing } from './extract/grid'

export async function launchHeadedBrowser(): Promise<{ close: () => Promise<void>; page: Page }> {
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext()
  const page = await context.newPage()
  return { page, close: () => browser.close() }
}

export function createBrowserDriver(page: Page): PageDriver {
  return {
    async gotoSearch(query: string, location: string) {
      const url = `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(query)}&location=${encodeURIComponent(location)}`
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
