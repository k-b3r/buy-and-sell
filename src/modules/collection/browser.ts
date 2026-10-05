import { chromium, type Page } from 'playwright'
import type { BrowserDriver, BrowserProxy, PageDriver } from './driver'
import type { GridListing } from './extract/grid'
import type { PageCursor } from './paginate'

const DASMARINAS_CAVITE_COORDS = { latitude: 14.3294, longitude: 120.9367 }

// Only the embedded JSON in the page is ever read (see extract/grid.ts,
// extract/detail.ts) — actual photos are downloaded separately via plain
// fetch() in images.ts, never through the browser. So Chromium rendering
// real images/fonts/stylesheets/media for every navigation is pure wasted
// CPU/memory/bandwidth. Deliberately NOT blocking 'fetch'/'xhr' — the
// GraphQL pagination call in fetchNextPage below depends on that.
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'stylesheet', 'media'])

export function shouldBlockResource(resourceType: string): boolean {
  return BLOCKED_RESOURCE_TYPES.has(resourceType)
}

// Collection's browser entry: the one place a Chromium gets launched. Callers
// route through whichever residential proxy they resolved (see proxy.ts and
// server/proxyGuard.ts); headless is only turned off for local inspection.
export async function launchBrowserDriver(
  proxy?: BrowserProxy,
  options: { headless?: boolean } = {},
): Promise<BrowserDriver> {
  const { page, close } = await launchBrowser({ headless: options.headless, proxy })
  return { driver: createBrowserDriver(page), close }
}

async function launchBrowser(options: {
  headless?: boolean
  proxy?: BrowserProxy
}): Promise<{ close: () => Promise<void>; page: Page }> {
  const browser = await chromium.launch({
    headless: options.headless ?? true,
    proxy: options.proxy,
    args: [
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-sync',
      '--disable-translate',
      '--disable-default-apps',
      '--mute-audio',
      '--no-first-run',
    ],
  })
  const context = await browser.newContext({
    locale: 'en-PH',
    timezoneId: 'Asia/Manila',
    geolocation: DASMARINAS_CAVITE_COORDS,
    permissions: ['geolocation'],
  })
  const page = await context.newPage()
  await page.route('**/*', (route) => {
    if (shouldBlockResource(route.request().resourceType())) {
      return route.abort()
    }
    return route.continue()
  })
  return { page, close: () => browser.close() }
}

function createBrowserDriver(page: Page): PageDriver {
  return {
    async gotoSearch(query: string, daysSinceListed: number) {
      // No location parameter here at all — Facebook has no reliable free-text
      // location signal for a logged-out session (confirmed: location= URL param,
      // geolocation permission, and locale/timezone were all ignored, defaulting
      // to a generic US region).
      // What does work is a location *slug* path segment, but only recognized
      // slugs resolve — "manila" is confirmed working and already surfaces
      // Dasmarinas/Cavite-area listings; "dasmarinas" itself is not a
      // recognized slug and falls back to the generic default.
      const url = `https://www.facebook.com/marketplace/manila/search/?query=${encodeURIComponent(query)}&daysSinceListed=${daysSinceListed}&exact=false`
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
    async fetchNextPage(cursor: PageCursor, lsd: string, query: string) {
      return page.evaluate(
        async ({ cursor, lsd, query }) => {
          const variables = {
            count: 24,
            cursor: cursor.raw,
            params: {
              bqf: { callsite: 'COMMERCE_MKTPLACE_WWW', query },
              browse_request_params: {
                commerce_enable_local_pickup: true,
                commerce_enable_shipping: true,
                commerce_search_and_rp_available: true,
                commerce_search_and_rp_category_id: [],
                commerce_search_and_rp_condition: null,
                commerce_search_and_rp_ctime_days: Array.from(
                  { length: 31 },
                  (_, i) => Math.floor(Date.now() / 86400000) - i,
                ).join(';'),
                filter_location_latitude: 14.5896,
                filter_location_longitude: 120.9808,
                filter_price_lower_bound: 0,
                filter_price_upper_bound: 214748364700,
                filter_radius_km: 65,
              },
              custom_request_params: {
                browse_context: null,
                contextual_filters: [],
                referral_code: null,
                referral_ui_component: null,
                saved_search_strid: null,
                search_vertical: 'C2C',
                seo_url: null,
                serp_landing_settings: { virtual_category_id: '' },
                surface: 'SEARCH',
                virtual_contextual_filters: [],
              },
            },
            scale: 1,
            __relay_internal__pv__GHLShouldChangeMarketplaceSponsoredDataFieldNamerelayprovider: false,
          }
          const body = new URLSearchParams({
            lsd,
            fb_api_caller_class: 'RelayModern',
            fb_api_req_friendly_name: 'CometMarketplaceSearchContentPaginationQuery',
            variables: JSON.stringify(variables),
            server_timestamps: 'true',
            doc_id: '27212616558440397',
          })
          const res = await fetch('https://www.facebook.com/api/graphql/', {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'x-fb-lsd': lsd,
              'x-fb-friendly-name': 'CometMarketplaceSearchContentPaginationQuery',
            },
            body: body.toString(),
            credentials: 'include',
          })
          return res.text()
        },
        { cursor, lsd, query },
      )
    },
  }
}
