# Marketplace Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the v0 collector to fetch listings beyond Facebook's initial 24-item batch, using the confirmed-reachable logged-out GraphQL pagination endpoint, chained through real cursors extracted from the live page — without ever logging in.

**Architecture:** Extend `PageDriver` with a `fetchNextPage` method that issues a same-origin `fetch()` from inside the already-loaded page (via `page.evaluate`), reusing the page's own `lsd` token and the real `end_cursor` Facebook embeds in the initial SSR payload. A new `src/paginate.ts` holds pure, TDD'd extraction/parsing functions (cursor/lsd extraction from HTML, response parsing) so the GraphQL wire format is testable without hitting the live site. `run.ts` gains an optional continuation loop that keeps fetching pages (same pacing/wall-handling discipline as the existing per-item loop) until a configured cap or `has_next_page: false`.

**Tech Stack:** Node.js, TypeScript, Playwright (headed Chromium), Vitest — same as the base collector.

**Spec:** `CONTEXT.md` (this repo) — see "Pagination beyond initial batch" under Domain Terms, and `docs/superpowers/plans/2026-08-17-marketplace-collector.md` (the base plan this extends).

## Global Constraints

- No login/session/cookies — logged-out only. This pagination approach was specifically confirmed reachable (HTTP 200) without login; do not add auth to make it "just work" if it stalls — that reopens the account-ban risk the whole project avoids.
- ₱0 budget: no paid proxies/APIs.
- Confirmed working request identity: `x-fb-friendly-name: CometMarketplaceSearchContentPaginationQuery`, `doc_id: 27212616558440397`. Do not invent a different doc_id/query name without re-confirming live (doc_ids are Facebook-internal and can change).
- The `lsd` token and `end_cursor` MUST be extracted fresh from the live page for every run — never hardcode a captured value, they are single-session/short-lived.
- Randomized 4-10s delay between page fetches too (reuse the existing `waitRandom` pattern) — pagination calls are still live requests against Facebook and should follow the same pacing discipline as listing navigations.
- Any pagination response that isn't a clean, parseable success shape: fail closed, stop, log — same "never guess/retry blindly" rule as the base plan's wall-handling.
- Still JSONL output, still CLI y/n/s review per listing — pagination only changes where listings come from, not how they're reviewed/saved.

---

## File Structure

```
src/
  paginate.ts           # pure: extract cursor/lsd from HTML, parse GraphQL response
  driver.ts              # MODIFY: add fetchNextPage to PageDriver interface
  browser.ts              # MODIFY: real fetchNextPage implementation via page.evaluate
  run.ts                   # MODIFY: optional pagination continuation loop
  cli.ts                    # MODIFY: max-items/max-pages arg
test/
  paginate.test.ts
fixtures/
  ssr-page-with-cursor.html   # SSR page fixture with real-shaped end_cursor + lsd
  pagination-response.json     # GraphQL response fixture with edges + next cursor
  pagination-response-empty.json  # edges: [] fixture (the "params mismatch" case seen live)
```

---

### Task 1: Cursor/LSD Extraction (pure, TDD)

**Files:**
- Create: `src/paginate.ts`
- Create: `fixtures/ssr-page-with-cursor.html`
- Test: `test/paginate.test.ts`

**Interfaces:**
- Produces: `interface PageCursor { raw: string; pg: number }`, `extractCursor(html: string): PageCursor | null`, `extractLsd(html: string): string | null`.

`extractCursor` finds the `"end_cursor":"..."` JSON-string value under `page_info` in the SSR HTML, JSON-unescapes it once (it's a JSON string containing escaped JSON), then parses that as JSON to read `pg`. Returns `{ raw: <the still-escaped-for-reuse string>, pg: <number> }` — `raw` is what gets sent back verbatim in the next request's `cursor` variable. `extractLsd` finds the `lsd` token from the `["LSD",[],{"token":"..."}]` pattern Facebook embeds in every page (confirmed present on logged-out pages).

- [ ] **Step 1: Write the failing test with fixture**

```html
<!-- fixtures/ssr-page-with-cursor.html -->
<html><body>
<script type="application/json">{"require":[["LSD",[],{"token":"FAKE_LSD_TOKEN_0000000000"}]]}</script>
<script type="application/json">{"data":{"marketplace_search":{"feed_units":{"edges":[{"node":{"id":"1"}}],"page_info":{"end_cursor":"{\"pg\":0,\"b2c\":{\"br\":\"\",\"it\":0,\"hmsr\":false,\"tbi\":0},\"c2c\":{\"br\":\"OPAQUE_TOKEN_ABC\",\"it\":24,\"rpbr\":\"\",\"rphr\":false,\"rmhr\":false,\"ssi\":false,\"ssco\":0,\"sspi\":[]},\"irr\":false,\"serp_cta\":false,\"rui\":[],\"mpid\":[],\"ubp\":null,\"ncrnd\":0,\"irsr\":false,\"bmpr\":[],\"bmpeid\":[],\"nmbmp\":false,\"skrr\":false,\"ioour\":false,\"ise\":false,\"sms_cursor\":{\"page_index\":0,\"blended_ad_index\":0,\"organics_since_last_ad\":0,\"page_organic_count\":0,\"blended_organic_index\":0,\"returned_ad_index\":0,\"total_index\":0}}","has_next_page":true}}}}}</script>
</body></html>
```

```ts
// test/paginate.test.ts
import { readFileSync } from 'node:fs'
import { extractCursor, extractLsd } from '../src/paginate'

test('extractCursor reads pg and keeps raw string for reuse', () => {
  const html = readFileSync('fixtures/ssr-page-with-cursor.html', 'utf-8')
  const cursor = extractCursor(html)
  expect(cursor).not.toBeNull()
  expect(cursor!.pg).toBe(0)
  expect(cursor!.raw).toContain('OPAQUE_TOKEN_ABC')
})

test('extractCursor returns null when no cursor present', () => {
  expect(extractCursor('<html></html>')).toBeNull()
})

test('extractLsd reads the LSD token', () => {
  const html = readFileSync('fixtures/ssr-page-with-cursor.html', 'utf-8')
  expect(extractLsd(html)).toBe('FAKE_LSD_TOKEN_0000000000')
})

test('extractLsd returns null when absent', () => {
  expect(extractLsd('<html></html>')).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- paginate`
Expected: FAIL — `src/paginate.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/paginate.ts
export interface PageCursor {
  raw: string
  pg: number
}

export function extractCursor(html: string): PageCursor | null {
  const match = html.match(/"end_cursor":"((?:[^"\\]|\\.)*)"/)
  if (!match) return null
  const raw = JSON.parse(`"${match[1]}"`)
  const parsed = JSON.parse(raw) as { pg: number }
  return { raw, pg: parsed.pg }
}

export function extractLsd(html: string): string | null {
  const match = html.match(/\["LSD",\[\],\{"token":"([^"]+)"/)
  return match ? match[1] : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- paginate`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/paginate.ts fixtures/ssr-page-with-cursor.html test/paginate.test.ts
git commit -m "add cursor/lsd extraction for marketplace pagination"
```

---

### Task 2: Pagination Response Parsing (pure, TDD)

**Files:**
- Modify: `src/paginate.ts`
- Create: `fixtures/pagination-response.json`
- Create: `fixtures/pagination-response-empty.json`
- Test: `test/paginate.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `interface PaginationPage { nodes: Record<string, unknown>[]; nextCursor: PageCursor | null; hasNextPage: boolean }`, `parsePaginationResponse(json: string): PaginationPage | null`. Returns `null` if the response doesn't have the expected `data.marketplace_search.feed_units` shape (fail-closed signal for the caller, same philosophy as `detectPageState`).

- [ ] **Step 1: Write the failing test with fixtures**

```json
// fixtures/pagination-response.json
{"data":{"marketplace_search":{"feed_units":{"edges":[{"node":{"id":"111","marketplace_listing_title":"Sony WH-1000XM6"}},{"node":{"id":"222","marketplace_listing_title":"Beats Solo"}}],"page_info":{"end_cursor":"{\"pg\":1,\"c2c\":{\"br\":\"NEXT_TOKEN\"}}","has_next_page":true}}}}}
```

```json
// fixtures/pagination-response-empty.json
{"data":{"marketplace_search":{"feed_units":{"edges":[],"page_info":{"end_cursor":"{\"pg\":1,\"c2c\":{\"br\":\"NEXT_TOKEN\"}}","has_next_page":false}}}}}
```

```ts
// test/paginate.test.ts (append to existing file)
import { parsePaginationResponse } from '../src/paginate'

test('parsePaginationResponse extracts nodes and next cursor', () => {
  const json = readFileSync('fixtures/pagination-response.json', 'utf-8')
  const page = parsePaginationResponse(json)
  expect(page).not.toBeNull()
  expect(page!.nodes).toHaveLength(2)
  expect(page!.nodes[0].id).toBe('111')
  expect(page!.hasNextPage).toBe(true)
  expect(page!.nextCursor!.pg).toBe(1)
})

test('parsePaginationResponse handles empty edges (the live params-mismatch case)', () => {
  const json = readFileSync('fixtures/pagination-response-empty.json', 'utf-8')
  const page = parsePaginationResponse(json)
  expect(page!.nodes).toHaveLength(0)
  expect(page!.hasNextPage).toBe(false)
})

test('parsePaginationResponse returns null on unexpected shape', () => {
  expect(parsePaginationResponse('{"errors":[{"message":"boom"}]}')).toBeNull()
  expect(parsePaginationResponse('not json')).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- paginate`
Expected: FAIL — `parsePaginationResponse` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/paginate.ts
export interface PaginationPage {
  nodes: Record<string, unknown>[]
  nextCursor: PageCursor | null
  hasNextPage: boolean
}

export function parsePaginationResponse(json: string): PaginationPage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const feedUnits = (parsed as any)?.data?.marketplace_search?.feed_units
  if (!feedUnits || !Array.isArray(feedUnits.edges) || !feedUnits.page_info) {
    return null
  }
  const nodes = feedUnits.edges.map((edge: any) => edge.node as Record<string, unknown>)
  const pageInfo = feedUnits.page_info as { end_cursor: string; has_next_page: boolean }
  let nextCursor: PageCursor | null = null
  try {
    nextCursor = { raw: pageInfo.end_cursor, pg: JSON.parse(pageInfo.end_cursor).pg }
  } catch {
    nextCursor = null
  }
  return { nodes, nextCursor, hasNextPage: pageInfo.has_next_page }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- paginate`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/paginate.ts fixtures/pagination-response.json fixtures/pagination-response-empty.json test/paginate.test.ts
git commit -m "add pagination response parsing"
```

---

### Task 3: Extend PageDriver with fetchNextPage

**Files:**
- Modify: `src/driver.ts`
- Modify: `src/browser.ts`

**Interfaces:**
- Consumes: `PageCursor` from `src/paginate.ts`.
- Produces: extends `PageDriver` with `fetchNextPage(cursor: PageCursor, lsd: string, query: string): Promise<string>` — returns the raw GraphQL response body text (parsing happens in `run.ts` via `parsePaginationResponse`, keeping `browser.ts` a thin real-API wrapper same as the rest of the file).

- [ ] **Step 1: Add to the PageDriver interface**

```ts
// src/driver.ts — add to the existing interface
import type { PageCursor } from './paginate'

export interface PageDriver {
  gotoSearch(query: string, location: string): Promise<void>
  getGridHtml(): Promise<string>
  openListing(listing: GridListing): Promise<void>
  getDetailHtml(): Promise<string>
  refresh(): Promise<void>
  waitRandom(minMs: number, maxMs: number): Promise<void>
  fetchNextPage(cursor: PageCursor, lsd: string, query: string): Promise<string>
}
```

- [ ] **Step 2: Implement in browser.ts**

This is NOT unit-tested (same as the rest of `browser.ts` — it wraps live Playwright/fetch APIs). It will be exercised in Task 5's manual calibration.

```ts
// src/browser.ts — add to createBrowserDriver's returned object
async fetchNextPage(cursor, lsd, query) {
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
            commerce_search_and_rp_ctime_days: 30,
            filter_location_latitude: 14.3294,
            filter_location_longitude: 120.9367,
            filter_price_lower_bound: 0,
            filter_price_upper_bound: 214748364700,
            filter_radius_km: 40,
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
```

**⚠️ Known gap, addressed in Task 5:** the `browse_request_params` values above are hand-approximated — a live test with this exact shape returned HTTP 200 but `edges: []`. Task 5's live calibration replaces these with values extracted from the real page rather than guessed.

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: clean (no test to run — this task has no automated test, per the interface note above).

- [ ] **Step 4: Commit**

```bash
git add src/driver.ts src/browser.ts
git commit -m "add fetchNextPage to PageDriver"
```

---

### Task 4: Pagination Continuation Loop in run.ts

**Files:**
- Modify: `src/run.ts`
- Modify: `src/cli.ts`
- Test: `test/run.test.ts` (append)

**Interfaces:**
- Consumes: `extractCursor`, `extractLsd`, `parsePaginationResponse` from `src/paginate.ts`; `driver.fetchNextPage` from Task 3.
- Produces: `RunOptions` gains `maxItems?: number` (default: unlimited — same as today's single-batch behavior when omitted, preserving v0's existing behavior for callers that don't set it).

- [ ] **Step 1: Write the failing test**

```ts
// test/run.test.ts (append to existing file)
test('paginates for more items when maxItems exceeds first batch, deduping by id', async () => {
  const gridHtml = `<script type="application/json">{"results":[{"id":"1","marketplace_listing_title":"Mic A"}]}</script>
<script type="application/json">{"require":[["LSD",[],{"token":"tok123"}]]}</script>
<script type="application/json">{"data":{"marketplace_search":{"feed_units":{"edges":[],"page_info":{"end_cursor":"{\\"pg\\":0,\\"c2c\\":{\\"br\\":\\"x\\"}}","has_next_page":true}}}}}</script>`
  const detailHtml = `<script type="application/json">{"id":"1","marketplace_listing_title":"Mic"}</script>`
  const paginationResponse = JSON.stringify({
    data: {
      marketplace_search: {
        feed_units: {
          edges: [{ node: { id: '2', marketplace_listing_title: 'Mic B' } }],
          page_info: { end_cursor: '{"pg":1,"c2c":{"br":"y"}}', has_next_page: false },
        },
      },
    },
  })

  const driver: PageDriver = {
    gotoSearch: async () => {},
    getGridHtml: async () => gridHtml,
    openListing: async () => {},
    getDetailHtml: async () => detailHtml,
    refresh: async () => {},
    waitRandom: async () => {},
    fetchNextPage: async () => paginationResponse,
  }
  const logger = createLogger(LOG_PATH)

  await runCollection(driver, logger, async () => 'approve', mockInput(), silentOutput(), {
    query: 'headphones',
    location: 'Dasmarinas, Cavite',
    outputPath: OUT_PATH,
    softWallTimeoutMs: 100,
    maxItems: 2,
  })

  const saved = readFileSync(OUT_PATH, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
  expect(saved.map((s) => s.id)).toEqual(['1', '2'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- run.test`
Expected: FAIL — `fetchNextPage` missing from mock driver type error, or `maxItems` unused/no pagination happens (only 1 saved, not 2).

- [ ] **Step 3: Implement the continuation loop**

```ts
// src/run.ts — modify RunOptions and the grid-fetch section
import { extractCursor, extractLsd, parsePaginationResponse } from './paginate'

export interface RunOptions {
  query: string
  location: string
  outputPath: string
  softWallTimeoutMs: number
  maxItems?: number
}
```

```ts
// src/run.ts — replace the `const listings = extractGridListings(gridResult.html)` section
  const seen = new Set<string>()
  const listings = extractGridListings(gridResult.html).filter((l) => {
    if (seen.has(l.id)) return false
    seen.add(l.id)
    return true
  })
  logger.info(`found ${listings.length} listings in search grid`)

  const maxItems = options.maxItems ?? listings.length
  let cursor = extractCursor(gridResult.html)
  let hasNextPage = true
  while (listings.length < maxItems && cursor && hasNextPage) {
    const lsd = extractLsd(gridResult.html)
    if (!lsd) {
      logger.error('no lsd token found for pagination, stopping')
      break
    }
    await driver.waitRandom(4000, 10000)
    const raw = await driver.fetchNextPage(cursor, lsd, options.query)
    const page = parsePaginationResponse(raw)
    if (!page) {
      logger.error('unrecognized pagination response shape, failing closed and stopping pagination')
      break
    }
    for (const node of page.nodes) {
      const id = node.id as string
      if (!seen.has(id)) {
        seen.add(id)
        listings.push(node as (typeof listings)[number])
      }
    }
    logger.info(`paginated: now have ${listings.length} listings (page ${cursor.pg} -> ${page.nextCursor?.pg ?? '?'})`)
    cursor = page.nextCursor
    hasNextPage = page.hasNextPage
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- run.test`
Expected: PASS

- [ ] **Step 5: Add CLI flag**

```ts
// src/cli.ts — add a third optional argv for max items
const maxItemsArg = process.argv[4]
const maxItems = maxItemsArg ? Number(maxItemsArg) : undefined
```

```ts
// src/cli.ts — pass through to runCollection's options
    await runCollection(driver, logger, promptReview, process.stdin, process.stdout, {
      query,
      location,
      outputPath: 'data/listings.jsonl',
      softWallTimeoutMs: 5000,
      maxItems,
    })
```

- [ ] **Step 6: Run full suite and type-check**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: all tests pass, clean type-check.

- [ ] **Step 7: Commit**

```bash
git add src/run.ts src/cli.ts test/run.test.ts
git commit -m "add pagination continuation loop with dedup and item cap"
```

---

### Task 5: Manual Live Calibration (not TDD — real-site verification)

Same category as the base plan's Task 10: this can't be automated, because the exact `browse_request_params` Facebook's own client sends can only be observed on the live site, and CI can't safely hit live Facebook.

**Files:**
- Modify: `src/browser.ts` (the `browse_request_params` object in `fetchNextPage`)

- [ ] **Step 1: Find the real browse_request_params in the live page**

```bash
pnpm run collect -- headphones "Dasmarinas, Cavite" 999
```

Before the pagination loop runs, or in a throwaway script, dump the initial page's HTML and grep for the params key that the page's OWN Relay/React runtime used for its first query (not the pagination query — the initial `CometMarketplaceSearchContentQuery` or similar, which should be embedded for hydration):

```bash
grep -o '"browse_request_params":{[^}]*}' /tmp/last-grid-page.html
```

(Add a temporary `writeFileSync('/tmp/last-grid-page.html', gridResult.html)` call in `run.ts` if needed for this one-off inspection — remove it before committing.)

- [ ] **Step 2: Compare against the hand-approximated values in browser.ts**

The known-wrong guess from today's live test used `filter_radius_km: 40` and `commerce_search_and_rp_ctime_days: 30` — check whether the real page uses different values, different key names entirely, or an entirely different `custom_request_params` shape.

- [ ] **Step 3: Update fetchNextPage with the real values**

Replace the hand-approximated `browse_request_params`/`custom_request_params` objects in `src/browser.ts`'s `fetchNextPage` with whatever the live page actually uses.

- [ ] **Step 4: Confirm pagination returns real, non-empty pages**

Run the CLI with a `maxItems` above 24 and confirm in `data/collector.log` that the `paginated: now have N listings` log line shows N growing past 24 with real listing data (not empty `edges: []`).

- [ ] **Step 5: Confirm pacing and fail-closed behavior hold under pagination**

Watch that the 4-10s delay is applied between page fetches (not just between listing detail navigations), and that an injected bad `lsd`/cursor (e.g., temporarily corrupt one character) causes a clean `[ERROR]` stop rather than a silent empty loop.

- [ ] **Step 6: Commit calibration fixes**

```bash
git add src/browser.ts
git commit -m "calibrate real browse_request_params for pagination against live Facebook"
```

---

## Self-Review Notes

- **Spec coverage:** confirmed request identity (doc_id/friendly-name) → Task 3. Fresh lsd/cursor extraction (never hardcoded) → Task 1. Pacing on pagination calls → Task 4's `waitRandom` call + Task 5 step 5 verification. Fail-closed on bad response shape → Task 2's `null` return + Task 4's `break` on null. Dedup (pagination can theoretically re-surface items) → Task 4's `seen` Set. Still JSONL/CLI-review unchanged → Task 4 reuses existing `runCollection` review loop untouched. The empty-`edges` gap found live today → explicitly named as Task 3's known gap and Task 5's calibration target.
- **Placeholder scan:** none found — all steps have concrete code, including the deliberately-flagged "known gap" which is real information, not a TODO.
- **Type consistency:** `PageCursor`, `PaginationPage` defined once in Task 1/2, reused identically in `driver.ts` (Task 3), `run.ts` (Task 4). `RunOptions.maxItems` is optional so existing base-plan callers/tests are unaffected.
