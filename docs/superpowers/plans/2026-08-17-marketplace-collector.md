# Marketplace Collector v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a manually-triggered, headed-browser collector that searches Facebook Marketplace (logged-out) for a given query near Dasmariñas, Cavite, walks results one at a time with human y/n/stop review, and appends approved listings to a JSONL file.

**Architecture:** Node.js/TypeScript CLI. A `PageDriver` interface abstracts Playwright so the orchestration loop (`run.ts`) is unit-testable with a mock driver; only the thin `browser.ts` implementation touches real Playwright. Pure extraction/logic functions (logger, output writer, review prompt, wall-state detector, grid/detail extractors) are TDD'd against fixtures. The final task is manual calibration against the live site, since exact Facebook DOM/JSON shapes can't be known until tested live.

**Tech Stack:** Node.js, TypeScript, Playwright (headed Chromium), Vitest.

**Spec:** `CONTEXT.md` (this repo) — all resolved decisions under "Domain Terms".

## Global Constraints

- ₱0 budget: no paid proxies, no paid APIs, no paid DB hosting.
- No login/session/cookies — logged-out only. No account-ban risk by design.
- Headed browser only (visible window) for v0.
- Script drives navigation (auto top-to-bottom through grid); user never clicks inside the browser.
- Per-item flow: open detail → user y/n/stop prompt → only on "y" does it save, then advance.
- Randomized 4-10s delay between stage-2 (detail) navigations.
- Soft login-wall: wait up to 5s for user to manually refresh; if not, auto-refresh and continue.
- Any page state that isn't recognized as "normal" or "known soft-wall": fail closed, stop the run, log it. Never guess/retry blindly.
- Output: JSONL file only. No database in v0.
- Logs: human-readable, appended to a plain text file, timestamped.
- Default location filter: Dasmariñas, Cavite. Default test query: "headphones".
- No product-matching/canonicalization, no market stats, no deal scoring in v0 — out of scope.

---

## File Structure

```
src/
  logger.ts            # human-readable logging
  output.ts            # JSONL append writer
  review.ts            # CLI y/n/stop prompt
  wall.ts              # page-state detection (normal / soft-wall / hard-block)
  extract/
    grid.ts            # stage-1 search-results grid extraction
    detail.ts          # stage-2 individual listing extraction
  driver.ts            # PageDriver interface (shared contract)
  browser.ts           # real Playwright implementation of PageDriver
  run.ts               # orchestration loop (testable via mock PageDriver)
  cli.ts               # entrypoint: parse argv, wire deps, call run.ts
test/
  logger.test.ts
  output.test.ts
  review.test.ts
  wall.test.ts
  extract/grid.test.ts
  extract/detail.test.ts
  run.test.ts
fixtures/
  normal-page.html
  soft-wall-page.html
  hard-block-page.html
  grid-page.html
  detail-page.html
data/                   # gitignored: run output lands here
  listings.jsonl
  collector.log
```

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

**Interfaces:** none (setup only)

- [ ] **Step 1: Init git repo (none exists yet)**

```bash
git init
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "marketplace-collector",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "collect": "tsx src/cli.ts"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "playwright": "^1.47.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Install dependencies**

```bash
npm install
npx playwright install chromium
```

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 5: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
})
```

- [ ] **Step 6: Create .gitignore**

```
node_modules/
dist/
data/
*.log
```

- [ ] **Step 7: Verify install**

Run: `npm test`
Expected: vitest runs with "No test files found" (no tests yet) — confirms toolchain wired correctly.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore package-lock.json
git commit -m "scaffold marketplace collector project"
```

---

### Task 2: Logger

**Files:**
- Create: `src/logger.ts`
- Test: `test/logger.test.ts`

**Interfaces:**
- Produces: `createLogger(logFilePath: string): Logger` where `Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void }`. Each call writes a timestamped, human-readable line to stdout and appends the same line to `logFilePath`.

- [ ] **Step 1: Write the failing test**

```ts
// test/logger.test.ts
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { createLogger } from '../src/logger'

const LOG_PATH = 'test/tmp-logger.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

test('info/warn/error write human-readable timestamped lines to file', () => {
  const logger = createLogger(LOG_PATH)
  logger.info('starting run')
  logger.warn('soft wall detected')
  logger.error('hard block, stopping')

  const contents = readFileSync(LOG_PATH, 'utf-8')
  const lines = contents.trim().split('\n')

  expect(lines).toHaveLength(3)
  expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*\] \[INFO\] starting run$/)
  expect(lines[1]).toMatch(/\[WARN\] soft wall detected$/)
  expect(lines[2]).toMatch(/\[ERROR\] hard block, stopping$/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- logger`
Expected: FAIL — `src/logger.ts` does not exist / `createLogger` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/logger.ts
import { appendFileSync } from 'node:fs'

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

function writeLine(logFilePath: string, level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`
  console.log(line)
  appendFileSync(logFilePath, line + '\n')
}

export function createLogger(logFilePath: string): Logger {
  return {
    info: (msg) => writeLine(logFilePath, 'INFO', msg),
    warn: (msg) => writeLine(logFilePath, 'WARN', msg),
    error: (msg) => writeLine(logFilePath, 'ERROR', msg),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- logger`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/logger.ts test/logger.test.ts
git commit -m "add human-readable logger"
```

---

### Task 3: Output Writer (JSONL)

**Files:**
- Create: `src/output.ts`
- Test: `test/output.test.ts`

**Interfaces:**
- Produces: `appendApprovedListing(outputFilePath: string, listing: Record<string, unknown>): void` — appends one JSON object per line (JSON Lines format) to `outputFilePath`, creating the file if absent.

- [ ] **Step 1: Write the failing test**

```ts
// test/output.test.ts
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { appendApprovedListing } from '../src/output'

const OUT_PATH = 'test/tmp-listings.jsonl'

afterEach(() => {
  if (existsSync(OUT_PATH)) rmSync(OUT_PATH)
})

test('appends one JSON object per line', () => {
  appendApprovedListing(OUT_PATH, { id: '1', title: 'Sony WH-1000XM4' })
  appendApprovedListing(OUT_PATH, { id: '2', title: 'Audio-Technica ATH-M50x' })

  const lines = readFileSync(OUT_PATH, 'utf-8').trim().split('\n')
  expect(lines).toHaveLength(2)
  expect(JSON.parse(lines[0])).toEqual({ id: '1', title: 'Sony WH-1000XM4' })
  expect(JSON.parse(lines[1])).toEqual({ id: '2', title: 'Audio-Technica ATH-M50x' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- output`
Expected: FAIL — `src/output.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/output.ts
import { appendFileSync } from 'node:fs'

export function appendApprovedListing(outputFilePath: string, listing: Record<string, unknown>): void {
  appendFileSync(outputFilePath, JSON.stringify(listing) + '\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- output`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/output.ts test/output.test.ts
git commit -m "add JSONL output writer"
```

---

### Task 4: Review Prompt (y/n/stop)

**Files:**
- Create: `src/review.ts`
- Test: `test/review.test.ts`

**Interfaces:**
- Produces: `type ReviewDecision = 'approve' | 'reject' | 'stop'` and `promptReview(listing: Record<string, unknown>, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<ReviewDecision>`. Prints a summary of `listing` to `output`, then a prompt `"[y]es / [n]o / [s]top > "`; reads one line from `input`; `y`/`yes` → `'approve'`, `n`/`no` → `'reject'`, `s`/`stop` → `'stop'` (case-insensitive, trimmed). Anything else re-prompts.

- [ ] **Step 1: Write the failing test**

```ts
// test/review.test.ts
import { Readable, Writable } from 'node:stream'
import { promptReview } from '../src/review'

function mockInput(...lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + '\n').join(''))
}

function mockOutput(): { stream: Writable; text: () => string } {
  let text = ''
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString()
      cb()
    },
  })
  return { stream, text: () => text }
}

test('"y" resolves to approve', async () => {
  const out = mockOutput()
  const decision = await promptReview({ id: '1', title: 'Mic' }, mockInput('y'), out.stream)
  expect(decision).toBe('approve')
  expect(out.text()).toContain('title')
})

test('"n" resolves to reject', async () => {
  const decision = await promptReview({ id: '1' }, mockInput('n'), mockOutput().stream)
  expect(decision).toBe('reject')
})

test('"s" resolves to stop', async () => {
  const decision = await promptReview({ id: '1' }, mockInput('s'), mockOutput().stream)
  expect(decision).toBe('stop')
})

test('invalid input re-prompts until valid', async () => {
  const decision = await promptReview({ id: '1' }, mockInput('bogus', 'y'), mockOutput().stream)
  expect(decision).toBe('approve')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- review`
Expected: FAIL — `src/review.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/review.ts
import { createInterface } from 'node:readline'

export type ReviewDecision = 'approve' | 'reject' | 'stop'

export function promptReview(
  listing: Record<string, unknown>,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<ReviewDecision> {
  output.write(JSON.stringify(listing, null, 2) + '\n')

  const rl = createInterface({ input, output, terminal: false })

  return new Promise((resolve) => {
    rl.setPrompt('[y]es / [n]o / [s]top > ')
    rl.prompt()
    rl.on('line', (line) => {
      const answer = line.trim().toLowerCase()
      if (answer === 'y' || answer === 'yes') {
        rl.close()
        resolve('approve')
      } else if (answer === 'n' || answer === 'no') {
        rl.close()
        resolve('reject')
      } else if (answer === 's' || answer === 'stop') {
        rl.close()
        resolve('stop')
      } else {
        rl.prompt()
      }
    })
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- review`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review.ts test/review.test.ts
git commit -m "add y/n/stop review prompt"
```

---

### Task 5: Page-State Detector (wall / hard-block)

**Files:**
- Create: `src/wall.ts`
- Create: `fixtures/normal-page.html`
- Create: `fixtures/soft-wall-page.html`
- Create: `fixtures/hard-block-page.html`
- Test: `test/wall.test.ts`

**Interfaces:**
- Produces: `type PageState = 'normal' | 'soft-wall' | 'hard-block'` and `detectPageState(html: string): PageState`.

Detection is marker-string based for v0 — exact Facebook markup is unknown until live calibration (Task 10). The known soft-wall marker from the user's manual testing is a login-prompt overlay; heuristic: presence of a login-form marker (`"login_form"` or the text `"Log in to continue"`/`"You must log in"`) while marketplace content markers are still present → soft-wall. Presence of CAPTCHA/checkpoint markers (`"captcha"`, `"checkpoint"`, case-insensitive) → hard-block. Neither → normal.

- [ ] **Step 1: Write the failing test with fixtures**

```html
<!-- fixtures/normal-page.html -->
<html><body><div id="marketplace_feed_unit">Sony WH-1000XM4 - ₱8,500</div></body></html>
```

```html
<!-- fixtures/soft-wall-page.html -->
<html><body>
<div id="marketplace_feed_unit">Sony WH-1000XM4 - ₱8,500</div>
<div id="login_form">You must log in to continue browsing.</div>
</body></html>
```

```html
<!-- fixtures/hard-block-page.html -->
<html><body><div class="checkpoint_challenge">Please complete this CAPTCHA to continue.</div></body></html>
```

```ts
// test/wall.test.ts
import { readFileSync } from 'node:fs'
import { detectPageState } from '../src/wall'

test('normal page with no wall markers', () => {
  const html = readFileSync('fixtures/normal-page.html', 'utf-8')
  expect(detectPageState(html)).toBe('normal')
})

test('soft-wall page with login overlay', () => {
  const html = readFileSync('fixtures/soft-wall-page.html', 'utf-8')
  expect(detectPageState(html)).toBe('soft-wall')
})

test('hard-block page with captcha/checkpoint', () => {
  const html = readFileSync('fixtures/hard-block-page.html', 'utf-8')
  expect(detectPageState(html)).toBe('hard-block')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- wall`
Expected: FAIL — `src/wall.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/wall.ts
export type PageState = 'normal' | 'soft-wall' | 'hard-block'

const HARD_BLOCK_MARKERS = [/captcha/i, /checkpoint/i]
const LOGIN_WALL_MARKERS = [/login_form/i, /log in to continue/i, /you must log in/i]

export function detectPageState(html: string): PageState {
  if (HARD_BLOCK_MARKERS.some((re) => re.test(html))) {
    return 'hard-block'
  }
  if (LOGIN_WALL_MARKERS.some((re) => re.test(html))) {
    return 'soft-wall'
  }
  return 'normal'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- wall`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/wall.ts fixtures/normal-page.html fixtures/soft-wall-page.html fixtures/hard-block-page.html test/wall.test.ts
git commit -m "add page-state detector for soft-wall/hard-block"
```

---

### Task 6: Grid Extractor (Stage 1)

**Files:**
- Create: `src/extract/grid.ts`
- Create: `fixtures/grid-page.html`
- Test: `test/extract/grid.test.ts`

**Interfaces:**
- Produces: `interface GridListing { id: string; url: string; [field: string]: unknown }` and `extractGridListings(html: string): GridListing[]`.

Per resolved decision, extract whatever fields are present — no fixed schema. Implementation: recursively walk any `<script type="application/json">` blocks' parsed JSON, collecting objects that look like a listing (have an `id`-like key plus at least one price/title-like key), keeping all of that object's own fields as-is.

- [ ] **Step 1: Write the failing test with fixture**

```html
<!-- fixtures/grid-page.html -->
<html><body>
<script type="application/json" data-sjs>
{
  "require": [[["MarketplaceFeed"], {
    "results": [
      { "id": "111", "marketplace_listing_title": "Sony WH-1000XM4", "listing_price": { "amount": "8500", "currency": "PHP" }, "location_text": "Dasmarinas, Cavite" },
      { "id": "222", "marketplace_listing_title": "Audio-Technica ATH-M50x", "listing_price": { "amount": "4200", "currency": "PHP" }, "location_text": "Imus, Cavite" }
    ]
  }]]
}
</script>
</body></html>
```

```ts
// test/extract/grid.test.ts
import { readFileSync } from 'node:fs'
import { extractGridListings } from '../../src/extract/grid'

test('extracts listing-shaped objects from embedded JSON, keeping whatever fields exist', () => {
  const html = readFileSync('fixtures/grid-page.html', 'utf-8')
  const listings = extractGridListings(html)

  expect(listings).toHaveLength(2)
  expect(listings[0]).toMatchObject({
    id: '111',
    marketplace_listing_title: 'Sony WH-1000XM4',
  })
  expect(listings[1]).toMatchObject({ id: '222' })
})

test('returns empty array when no matching objects found', () => {
  expect(extractGridListings('<html><body>nothing here</body></html>')).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- extract/grid`
Expected: FAIL — `src/extract/grid.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extract/grid.ts
export interface GridListing {
  id: string
  [field: string]: unknown
}

const LISTING_KEY_HINTS = ['marketplace_listing_title', 'listing_price', 'custom_title']

function looksLikeListing(obj: unknown): obj is Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null) return false
  const record = obj as Record<string, unknown>
  return typeof record.id === 'string' && LISTING_KEY_HINTS.some((key) => key in record)
}

function walk(node: unknown, found: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, found)
    return
  }
  if (typeof node === 'object' && node !== null) {
    if (looksLikeListing(node)) {
      found.push(node as Record<string, unknown>)
    }
    for (const value of Object.values(node)) walk(value, found)
  }
}

export function extractGridListings(html: string): GridListing[] {
  const found: Record<string, unknown>[] = []
  const scriptRegex = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g
  let match: RegExpExecArray | null
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      walk(parsed, found)
    } catch {
      // not valid JSON in this script block, skip
    }
  }
  return found as GridListing[]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- extract/grid`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extract/grid.ts fixtures/grid-page.html test/extract/grid.test.ts
git commit -m "add stage-1 grid listing extractor"
```

---

### Task 7: Detail Extractor (Stage 2)

**Files:**
- Create: `src/extract/detail.ts`
- Create: `fixtures/detail-page.html`
- Test: `test/extract/detail.test.ts`

**Interfaces:**
- Produces: `extractDetailFields(html: string): Record<string, unknown>`. Same walker strategy as grid extractor, but returns the single richest matching object found (the one with the most keys), since a detail page embeds one listing's full data. Returns `{}` if none found.

- [ ] **Step 1: Write the failing test with fixture**

```html
<!-- fixtures/detail-page.html -->
<html><body>
<script type="application/json" data-sjs>
{
  "require": [[["MarketplacePDP"], {
    "target": {
      "id": "111",
      "marketplace_listing_title": "Sony WH-1000XM4",
      "listing_price": { "amount": "8500", "currency": "PHP" },
      "redacted_description": { "text": "Barely used, comes with case and cable." },
      "condition": "Used - like new",
      "location_text": "Dasmarinas, Cavite",
      "photos": [{ "image": { "uri": "https://example.com/1.jpg" } }]
    }
  }]]
}
</script>
</body></html>
```

```ts
// test/extract/detail.test.ts
import { readFileSync } from 'node:fs'
import { extractDetailFields } from '../../src/extract/detail'

test('extracts the richest listing-shaped object with all its fields', () => {
  const html = readFileSync('fixtures/detail-page.html', 'utf-8')
  const detail = extractDetailFields(html)

  expect(detail.id).toBe('111')
  expect(detail.condition).toBe('Used - like new')
  expect(detail.redacted_description).toEqual({ text: 'Barely used, comes with case and cable.' })
})

test('returns empty object when nothing found', () => {
  expect(extractDetailFields('<html></html>')).toEqual({})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- extract/detail`
Expected: FAIL — `src/extract/detail.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extract/detail.ts
const LISTING_KEY_HINTS = ['marketplace_listing_title', 'listing_price', 'custom_title']

function looksLikeListing(obj: unknown): obj is Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null) return false
  const record = obj as Record<string, unknown>
  return typeof record.id === 'string' && LISTING_KEY_HINTS.some((key) => key in record)
}

function walk(node: unknown, found: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, found)
    return
  }
  if (typeof node === 'object' && node !== null) {
    if (looksLikeListing(node)) {
      found.push(node as Record<string, unknown>)
    }
    for (const value of Object.values(node)) walk(value, found)
  }
}

export function extractDetailFields(html: string): Record<string, unknown> {
  const found: Record<string, unknown>[] = []
  const scriptRegex = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g
  let match: RegExpExecArray | null
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      walk(parsed, found)
    } catch {
      // not valid JSON in this script block, skip
    }
  }
  if (found.length === 0) return {}
  return found.reduce((richest, candidate) =>
    Object.keys(candidate).length > Object.keys(richest).length ? candidate : richest,
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- extract/detail`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extract/detail.ts fixtures/detail-page.html test/extract/detail.test.ts
git commit -m "add stage-2 detail listing extractor"
```

---

### Task 8: PageDriver Interface + Orchestration Loop

**Files:**
- Create: `src/driver.ts`
- Create: `src/run.ts`
- Test: `test/run.test.ts`

**Interfaces:**
- Consumes: `Logger` from `src/logger.ts`, `appendApprovedListing` from `src/output.ts`, `promptReview`/`ReviewDecision` from `src/review.ts`, `detectPageState`/`PageState` from `src/wall.ts`, `extractGridListings`/`GridListing` from `src/extract/grid.ts`, `extractDetailFields` from `src/extract/detail.ts`.
- Produces:
  - `interface PageDriver { gotoSearch(query: string, location: string): Promise<void>; getGridHtml(): Promise<string>; openListing(listing: GridListing): Promise<void>; getDetailHtml(): Promise<string>; refresh(): Promise<void>; waitRandom(minMs: number, maxMs: number): Promise<void> }`
  - `interface RunOptions { query: string; location: string; outputPath: string; softWallTimeoutMs: number }`
  - `runCollection(driver: PageDriver, logger: Logger, review: typeof promptReview, input: NodeJS.ReadableStream, output: NodeJS.WritableStream, options: RunOptions): Promise<void>`

- [ ] **Step 1: Define the PageDriver interface**

```ts
// src/driver.ts
import type { GridListing } from './extract/grid'

export interface PageDriver {
  gotoSearch(query: string, location: string): Promise<void>
  getGridHtml(): Promise<string>
  openListing(listing: GridListing): Promise<void>
  getDetailHtml(): Promise<string>
  refresh(): Promise<void>
  waitRandom(minMs: number, maxMs: number): Promise<void>
}
```

- [ ] **Step 2: Write the failing test for the orchestration loop**

```ts
// test/run.test.ts
import { Readable, Writable } from 'node:stream'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import type { PageDriver } from '../src/driver'
import type { GridListing } from '../src/extract/grid'
import { runCollection } from '../src/run'
import { createLogger } from '../src/logger'

const OUT_PATH = 'test/tmp-run-listings.jsonl'
const LOG_PATH = 'test/tmp-run.log'

afterEach(() => {
  for (const p of [OUT_PATH, LOG_PATH]) if (existsSync(p)) rmSync(p)
})

function mockInput(...lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + '\n').join(''))
}

function silentOutput(): Writable {
  return new Writable({ write(_c, _e, cb) { cb() } })
}

function makeDriver(overrides: Partial<PageDriver> = {}): PageDriver {
  return {
    gotoSearch: async () => {},
    getGridHtml: async () => '<html></html>',
    openListing: async () => {},
    getDetailHtml: async () => '<html></html>',
    refresh: async () => {},
    waitRandom: async () => {},
    ...overrides,
  }
}

test('approved item gets saved, then loop advances to next item', async () => {
  const grid: GridListing[] = [
    { id: '1', marketplace_listing_title: 'Mic A' },
    { id: '2', marketplace_listing_title: 'Mic B' },
  ]
  const driver = makeDriver({
    getGridHtml: async () =>
      `<script type="application/json"><![CDATA[]]></script>`, // overridden below via monkeypatch
  })
  // Simplify: directly stub extractGridListings behavior by controlling getGridHtml + getDetailHtml content
  // using real fixture-shaped JSON so extractGridListings/extractDetailFields parse it for real.
  const gridHtml = `<script type="application/json">{"results":[
    {"id":"1","marketplace_listing_title":"Mic A"},
    {"id":"2","marketplace_listing_title":"Mic B"}
  ]}</script>`
  const detailHtml = (id: string) =>
    `<script type="application/json">{"id":"${id}","marketplace_listing_title":"Mic","condition":"Used"}</script>`

  let detailCallIndex = 0
  const ids = ['1', '2']
  const finalDriver = makeDriver({
    getGridHtml: async () => gridHtml,
    getDetailHtml: async () => detailHtml(ids[detailCallIndex++]),
  })

  const logger = createLogger(LOG_PATH)
  await runCollection(
    finalDriver,
    logger,
    async () => 'approve',
    mockInput(),
    silentOutput(),
    { query: 'headphones', location: 'Dasmarinas, Cavite', outputPath: OUT_PATH, softWallTimeoutMs: 100 },
  )

  const saved = readFileSync(OUT_PATH, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
  expect(saved).toHaveLength(2)
  expect(saved[0].id).toBe('1')
  expect(saved[1].id).toBe('2')
})

test('"stop" decision ends the run without processing remaining items', async () => {
  const gridHtml = `<script type="application/json">{"results":[
    {"id":"1","marketplace_listing_title":"Mic A"},
    {"id":"2","marketplace_listing_title":"Mic B"}
  ]}</script>`
  const detailHtml = `<script type="application/json">{"id":"1","marketplace_listing_title":"Mic"}</script>`

  const driver = makeDriver({
    getGridHtml: async () => gridHtml,
    getDetailHtml: async () => detailHtml,
  })
  const logger = createLogger(LOG_PATH)

  await runCollection(
    driver,
    logger,
    async () => 'stop',
    mockInput(),
    silentOutput(),
    { query: 'headphones', location: 'Dasmarinas, Cavite', outputPath: OUT_PATH, softWallTimeoutMs: 100 },
  )

  expect(existsSync(OUT_PATH)).toBe(false)
})

test('hard-block page state fails closed and stops the run', async () => {
  const gridHtml = `<script type="application/json">{"results":[
    {"id":"1","marketplace_listing_title":"Mic A"}
  ]}</script>`
  const hardBlockDetailHtml = `<div class="checkpoint_challenge">captcha</div>`

  const driver = makeDriver({
    getGridHtml: async () => gridHtml,
    getDetailHtml: async () => hardBlockDetailHtml,
  })
  const logger = createLogger(LOG_PATH)

  await runCollection(
    driver,
    logger,
    async () => 'approve',
    mockInput(),
    silentOutput(),
    { query: 'headphones', location: 'Dasmarinas, Cavite', outputPath: OUT_PATH, softWallTimeoutMs: 100 },
  )

  expect(existsSync(OUT_PATH)).toBe(false)
  const logText = readFileSync(LOG_PATH, 'utf-8')
  expect(logText).toContain('[ERROR]')
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- run.test`
Expected: FAIL — `src/run.ts` does not exist.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/run.ts
import type { PageDriver } from './driver'
import type { Logger } from './logger'
import type { ReviewDecision } from './review'
import { detectPageState } from './wall'
import { extractGridListings } from './extract/grid'
import { extractDetailFields } from './extract/detail'
import { appendApprovedListing } from './output'

export interface RunOptions {
  query: string
  location: string
  outputPath: string
  softWallTimeoutMs: number
}

type ReviewFn = (
  listing: Record<string, unknown>,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
) => Promise<ReviewDecision>

async function handlePageState(
  driver: PageDriver,
  logger: Logger,
  html: string,
  softWallTimeoutMs: number,
): Promise<'ok' | 'stop'> {
  const state = detectPageState(html)
  if (state === 'normal') return 'ok'

  if (state === 'soft-wall') {
    logger.warn('soft login-wall detected, waiting for manual refresh or auto-refresh fallback')
    await new Promise((resolve) => setTimeout(resolve, softWallTimeoutMs))
    await driver.refresh()
    return 'ok'
  }

  logger.error(`unrecognized page state "${state}", failing closed and stopping run`)
  return 'stop'
}

export async function runCollection(
  driver: PageDriver,
  logger: Logger,
  review: ReviewFn,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  options: RunOptions,
): Promise<void> {
  logger.info(`starting run: query="${options.query}" location="${options.location}"`)
  await driver.gotoSearch(options.query, options.location)

  const gridHtml = await driver.getGridHtml()
  const gridState = await handlePageState(driver, logger, gridHtml, options.softWallTimeoutMs)
  if (gridState === 'stop') return

  const listings = extractGridListings(gridHtml)
  logger.info(`found ${listings.length} listings in search grid`)

  for (const listing of listings) {
    await driver.openListing(listing)
    await driver.waitRandom(4000, 10000)

    const detailHtml = await driver.getDetailHtml()
    const detailState = await handlePageState(driver, logger, detailHtml, options.softWallTimeoutMs)
    if (detailState === 'stop') return

    const detail = extractDetailFields(detailHtml)
    const merged = { ...listing, ...detail }

    const decision = await review(merged, input, output)
    if (decision === 'stop') {
      logger.info('user stopped run')
      return
    }
    if (decision === 'approve') {
      appendApprovedListing(options.outputPath, merged)
      logger.info(`saved listing ${merged.id}`)
    } else {
      logger.info(`rejected listing ${merged.id}`)
    }
  }

  logger.info('run complete')
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- run.test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/driver.ts src/run.ts test/run.test.ts
git commit -m "add orchestration loop with wall handling and review gate"
```

---

### Task 9: Real Playwright Driver + CLI Entrypoint

**Files:**
- Create: `src/browser.ts`
- Create: `src/cli.ts`

**Interfaces:**
- Consumes: `PageDriver` from `src/driver.ts`, `runCollection` from `src/run.ts`, `createLogger` from `src/logger.ts`, `promptReview` from `src/review.ts`.
- Produces: `createBrowserDriver(page: Page): PageDriver` (real Playwright implementation); `cli.ts` is the executable entrypoint.

No unit test for this task — it wraps live Playwright APIs and is exercised by Task 10's manual calibration instead.

- [ ] **Step 1: Implement the real PageDriver**

```ts
// src/browser.ts
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
```

- [ ] **Step 2: Implement the CLI entrypoint**

```ts
// src/cli.ts
import { launchHeadedBrowser, createBrowserDriver } from './browser'
import { runCollection } from './run'
import { createLogger } from './logger'
import { promptReview } from './review'

async function main() {
  const query = process.argv[2] ?? 'headphones'
  const location = process.argv[3] ?? 'Dasmarinas, Cavite'

  const logger = createLogger('data/collector.log')
  const { page, close } = await launchHeadedBrowser()
  const driver = createBrowserDriver(page)

  try {
    await runCollection(driver, logger, promptReview, process.stdin, process.stdout, {
      query,
      location,
      outputPath: 'data/listings.jsonl',
      softWallTimeoutMs: 5000,
    })
  } finally {
    await close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 3: Create data directory**

```bash
mkdir -p data
```

- [ ] **Step 4: Verify it builds/runs (will hit real Facebook — expected to need Task 10 calibration)**

Run: `npm run collect -- headphones "Dasmarinas, Cavite"`
Expected: Headed Chromium opens, navigates to Marketplace search. Selector/marker mismatches against real Facebook markup are expected here — that's what Task 10 is for.

- [ ] **Step 5: Commit**

```bash
git add src/browser.ts src/cli.ts
git commit -m "add real Playwright driver and CLI entrypoint"
```

---

### Task 10: Manual Live Calibration (not TDD — real-site verification)

This task can't be automated: Facebook's actual DOM/embedded-JSON shape is unknown until observed live, and CI can't hit a real, logged-out Facebook session safely. Run this by hand.

**Files:**
- Modify: `src/wall.ts` (marker strings)
- Modify: `src/extract/grid.ts` (key hints, script-tag matching)
- Modify: `src/extract/detail.ts` (key hints)

- [ ] **Step 1: Run the CLI against the real site**

```bash
npm run collect -- headphones "Dasmarinas, Cavite"
```

- [ ] **Step 2: Confirm stage 1 grid extraction**

Check `data/collector.log` — does it report a nonzero listing count? If zero, open Chromium devtools on the live page, inspect `<script type="application/json">` blocks for the actual key names Facebook uses today (they may differ from the fixture guesses in Task 6/7 — e.g. `marketplace_listing_title` vs some other field name), then update `LISTING_KEY_HINTS` in `src/extract/grid.ts` and `src/extract/detail.ts` to match.

- [ ] **Step 3: Confirm stage 2 detail extraction**

Watch the browser open each listing in turn. Confirm the y/n/stop prompt shows a listing with title/price and (where present) condition/description. If detail fields are missing, inspect the real listing page's script tags and adjust `src/extract/detail.ts` accordingly.

- [ ] **Step 4: Confirm soft-wall handling**

Let a run continue until the known login-overlay appears (per user's earlier manual testing, this happens after a handful of navigations). Confirm: collector logs a `[WARN]`, waits ~5s, and either you refresh manually or it auto-refreshes and the run continues. If the overlay isn't detected, inspect its actual markup and update `LOGIN_WALL_MARKERS` in `src/wall.ts`.

- [ ] **Step 5: Confirm fail-closed behavior**

If a CAPTCHA or unrecognized state appears, confirm the run logs `[ERROR]` and stops — it must not loop or retry blindly. If it doesn't stop, tighten `detectPageState` in `src/wall.ts`.

- [ ] **Step 6: Confirm review + save loop end-to-end**

Approve one listing (`y`), reject one (`n`), stop the run (`s`). Confirm `data/listings.jsonl` has exactly one line (the approved one), and the log reflects all three actions.

- [ ] **Step 7: Commit calibration fixes**

```bash
git add src/wall.ts src/extract/grid.ts src/extract/detail.ts
git commit -m "calibrate extractors and wall detection against live Facebook Marketplace"
```

---

## Self-Review Notes

- **Spec coverage:** every resolved `CONTEXT.md` decision maps to a task — no-login/headed Playwright (Task 9), two-stage grid→detail (Task 6/7/8), sequential script-driven loop with y/n/stop (Task 8), soft-wall 5s-then-auto-refresh (Task 8), fail-closed on hard-block (Task 8), JSONL-only output (Task 3), human-readable logs (Task 2), 4-10s pacing (Task 8/9), Dasmariñas Cavite default + "headphones" query (Task 9), extract-whatever-fields-present (Task 6/7 walker approach), live calibration (Task 10).
- **Placeholder scan:** none found — all steps have concrete code.
- **Type consistency:** `GridListing`, `PageDriver`, `RunOptions`, `ReviewDecision`, `Logger` are defined once (Tasks 2/4/5/6/8) and reused with identical shapes across later tasks.
