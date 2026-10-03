# Product Extraction Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every collected listing a `product_id` pointing into a deduplicated `products` list, via a two-pass Gemini-based extraction: Pass 1 (fully automatic) assigns a `base_model` to every listing; Pass 2 (curated, run later/separately per product) splits specific products into finer `(base_model, variant_tier)` rows once a human defines that product's variant enum.

**Architecture:** Two CLI scripts mirroring the existing `backfill.ts` shape (resumable, dual-write to JSONL + Postgres, own log file). A thin `src/gemini.ts` wraps the `@google/genai` SDK behind a narrow, testable `GeminiClient` interface (same pattern as `DbClient` in `src/db.ts` and `ImageStore` in `src/images.ts`) so orchestration logic never touches the real SDK in tests. Prompt/schema construction and base-model normalization live in pure, TDD'd functions in `src/products.ts`. `loadListings`/`saveListings` — currently private to `backfill.ts` — get extracted to a shared `src/jsonl.ts` first, since both new scripts need them too.

**Tech Stack:** Node.js, TypeScript, `@google/genai` (Gemini SDK), `pg` (existing), Vitest — same as the rest of this repo.

**Spec:** `CONTEXT.md` — see "Product identification / canonical matching" under Domain Terms (the "Resolved design (2026-08-20)" entry has the full Pass 1 / Pass 2 design this plan implements).

## Global Constraints

- ₱0 budget: use the free-tier Gemini key (`FREE_GEMINI_API_KEY` in `.env`) and `gemini-2.5-flash`, not the paid key — free tier covers this workload comfortably (~40 requests for Pass 1 over 997 listings; see spec for the math).
- Structured JSON output via the SDK's schema/response-format mechanism — never free-text-parse a Gemini response. If a batch's response doesn't match the expected shape, log and skip that batch/product rather than crashing the whole run (same "fail closed on the unit that's broken, keep going" philosophy as `backfill.ts`'s soft-wall handling).
- Resumable: both scripts must be safe to re-run — already-assigned listings (`product_id` already set) are skipped, not re-processed.
- Dual-write: every `product_id` assignment/reassignment updates both `data/listings.jsonl` and the `listings` table in Postgres, same as the rest of this codebase.
- `variant_enums` rows are written externally (by the dashboard, a separate plan) — this pipeline only _reads_ them. Do not build any enum-curation UI here.
- TDD throughout — write the failing test before the implementation for every step below.

---

### Task 1: Extract shared JSONL helpers, refactor `backfill.ts` to use them

**Files:**

- Create: `src/jsonl.ts`
- Create: `test/jsonl.test.ts`
- Modify: `src/backfill.ts` (remove the local `loadListings`/`saveListings`, import from `./jsonl` instead)

**Interfaces:**

- Produces: `loadListings(path: string): Record<string, unknown>[]`, `saveListings(path: string, listings: Record<string, unknown>[]): void` — both new scripts in this plan depend on these.

- [ ] **Step 1: Write the failing test**

```ts
// test/jsonl.test.ts
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { loadListings, saveListings } from '../src/jsonl'

const PATH = 'test/tmp-jsonl.jsonl'

afterEach(() => {
  if (existsSync(PATH)) rmSync(PATH)
})

test('loadListings returns an empty array when the file does not exist', () => {
  expect(loadListings(PATH)).toEqual([])
})

test('saveListings then loadListings round-trips listings', () => {
  saveListings(PATH, [
    { id: '1', title: 'A' },
    { id: '2', title: 'B' },
  ])
  expect(loadListings(PATH)).toEqual([
    { id: '1', title: 'A' },
    { id: '2', title: 'B' },
  ])
})

test('loadListings skips blank lines', () => {
  writeFileSync(PATH, '{"id":"1"}\n\n{"id":"2"}\n')
  expect(loadListings(PATH)).toEqual([{ id: '1' }, { id: '2' }])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/jsonl.test.ts`
Expected: FAIL — `src/jsonl.ts` does not exist yet (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/jsonl.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export function loadListings(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

export function saveListings(path: string, listings: Record<string, unknown>[]): void {
  writeFileSync(path, listings.map((l) => JSON.stringify(l)).join('\n') + '\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/jsonl.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Refactor `backfill.ts` to use the shared module**

In `src/backfill.ts`, delete the local `loadListings`/`saveListings` function definitions (they're byte-for-byte the same as what Step 3 just created) and add:

```ts
import { loadListings, saveListings } from './jsonl'
```

- [ ] **Step 6: Run the full suite to verify nothing broke**

Run: `pnpm test`
Expected: PASS, same total test count as before Step 5 plus the 3 new `jsonl.test.ts` tests.

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/jsonl.ts test/jsonl.test.ts src/backfill.ts
git commit -m "extract shared JSONL load/save helpers from backfill.ts"
```

---

### Task 2: Pass 1 prompt/schema builders (`src/products.ts`)

**Files:**

- Create: `src/products.ts`
- Create: `test/products.test.ts`

**Interfaces:**

- Produces: `normalizeBaseModel(raw: string): string`, `ExtractionInput` type (`{id: string, title: string, description: string}`), `buildExtractionPrompt(listings: ExtractionInput[]): string`, `EXTRACTION_RESPONSE_SCHEMA` (const). Task 3 (`findOrCreateProduct`) and Task 5 (`extract-products.ts`) both consume these.

- [ ] **Step 1: Write the failing test**

```ts
// test/products.test.ts
import { normalizeBaseModel, buildExtractionPrompt, EXTRACTION_RESPONSE_SCHEMA } from '../src/products'

test('normalizeBaseModel trims, lowercases, and collapses internal whitespace', () => {
  expect(normalizeBaseModel('  RTX   3060  ')).toBe('rtx 3060')
  expect(normalizeBaseModel('iPhone 13')).toBe('iphone 13')
})

test('buildExtractionPrompt includes each listing id and title, and truncates long descriptions to 150 chars', () => {
  const longDesc =
    'Barely used, 2020 model, comes with charger and original box, no issues at all whatsoever really, works perfectly fine no scratches or dents anywhere on the case'
  const prompt = buildExtractionPrompt([
    { id: '1', title: 'Rush sale MacBook Air', description: longDesc },
    { id: '2', title: 'For sale rush', description: 'Sony WH-1000XM4 headphones' },
  ])

  expect(prompt).toContain('[id: 1] title: "Rush sale MacBook Air"')
  expect(prompt).toContain('[id: 2] title: "For sale rush"')
  expect(prompt).toContain('Sony WH-1000XM4 headphones')
  expect(prompt).not.toContain('no scratches or dents anywhere on the case')
})

test('EXTRACTION_RESPONSE_SCHEMA is an array schema requiring id and base_model per item', () => {
  expect(EXTRACTION_RESPONSE_SCHEMA.type).toBe('array')
  expect(EXTRACTION_RESPONSE_SCHEMA.items.required).toEqual(['id', 'base_model'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/products.test.ts`
Expected: FAIL — `src/products.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/products.ts
export function normalizeBaseModel(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

export interface ExtractionInput {
  id: string
  title: string
  description: string
}

const DESCRIPTION_TRUNCATE_LENGTH = 150

function formatListingLine(l: ExtractionInput): string {
  const desc = l.description.slice(0, DESCRIPTION_TRUNCATE_LENGTH)
  return `[id: ${l.id}] title: "${l.title}" desc: "${desc}"`
}

export function buildExtractionPrompt(listings: ExtractionInput[]): string {
  const lines = listings.map(formatListingLine).join('\n')
  return `Extract the base product model from each Facebook Marketplace listing below.
Return ONLY the core product line/model - strip seller phrases ("RUSH", "FOR SALE"),
condition, price, storage/color, and edition/variant details (write "RTX 3060" not
"RTX 3060 OC Asus"; write "iPhone 13" not "iPhone 13 128GB Blue"). If genuinely
unidentifiable even from the description, use a general category instead ("Laptop",
"Bicycle") rather than guessing wrong.

Listings:
${lines}`
}

export const EXTRACTION_RESPONSE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      base_model: { type: 'string' },
    },
    required: ['id', 'base_model'],
  },
} as const
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/products.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/products.ts test/products.test.ts
git commit -m "add product extraction prompt/schema builders"
```

---

### Task 3: `products`/`variant_enums` schema + `findOrCreateProduct`

**Files:**

- Modify: `db/schema.sql` (append new tables + `listings.product_id` column, idempotent)
- Modify: `src/db.ts` (add `findOrCreateProduct`)
- Modify: `test/db.test.ts` (add tests for `findOrCreateProduct`)

**Interfaces:**

- Consumes: `normalizeBaseModel` from `src/products.ts` (Task 2), `DbClient` (already in `src/db.ts`).
- Produces: `findOrCreateProduct(db: DbClient, baseModel: string, variantTier: string | null): Promise<number>` — Task 5 and Task 6 both call this.

- [ ] **Step 1: Write the failing test**

```ts
// append to test/db.test.ts
import { findOrCreateProduct } from '../src/db'

test('findOrCreateProduct inserts a new product when none matches, returns its id', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  let queryCount = 0
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      queryCount += 1
      if (queryCount === 1) return { rows: [] } // SELECT finds nothing
      return { rows: [{ id: 42 }] } // INSERT ... RETURNING id
    },
  }

  const id = await findOrCreateProduct(db, 'RTX 3060', null)

  expect(id).toBe(42)
  expect(calls[0].sql).toMatch(/^SELECT/)
  expect(calls[0].params).toEqual(['rtx 3060', null])
  expect(calls[1].sql).toMatch(/^INSERT/)
  expect(calls[1].params).toEqual(['RTX 3060', 'rtx 3060', null])
})

test('findOrCreateProduct reuses an existing product when normalized base_model + variant_tier already match', async () => {
  const db = { query: async () => ({ rows: [{ id: 7 }] }) }

  const id = await findOrCreateProduct(db, '  RTX 3060  ', 'Custom AIB/OC')

  expect(id).toBe(7)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/db.test.ts`
Expected: FAIL — `findOrCreateProduct` is not exported from `src/db.ts`.

- [ ] **Step 3: Add the schema migration**

Append to `db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  base_model TEXT NOT NULL,
  base_model_normalized TEXT NOT NULL,
  variant_tier TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS products_base_model_variant_idx
  ON products (base_model_normalized, COALESCE(variant_tier, ''));

CREATE TABLE IF NOT EXISTS variant_enums (
  base_model_normalized TEXT PRIMARY KEY,
  enum_values JSONB NOT NULL
);

ALTER TABLE listings ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id);
```

- [ ] **Step 4: Write minimal implementation**

In `src/db.ts`, add:

```ts
import { normalizeBaseModel } from './products'

export async function findOrCreateProduct(
  db: DbClient,
  baseModel: string,
  variantTier: string | null,
): Promise<number> {
  const normalized = normalizeBaseModel(baseModel)

  const existing = (await db.query(
    `SELECT id FROM products WHERE base_model_normalized = $1 AND variant_tier IS NOT DISTINCT FROM $2`,
    [normalized, variantTier],
  )) as { rows: { id: number }[] }
  if (existing.rows.length > 0) return existing.rows[0].id

  const inserted = (await db.query(
    `INSERT INTO products (base_model, base_model_normalized, variant_tier) VALUES ($1, $2, $3) RETURNING id`,
    [baseModel, normalized, variantTier],
  )) as { rows: { id: number }[] }
  return inserted.rows[0].id
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test test/db.test.ts`
Expected: PASS (all `db.test.ts` tests, including the 2 new ones)

- [ ] **Step 6: Apply the migration to the real database**

Run: `psql "$DATABASE_URL" -f db/schema.sql` (reads `DATABASE_URL` from `.env` — `source <(grep DATABASE_URL .env)` first if needed, same as prior sessions in this project)
Expected: `CREATE TABLE`/`CREATE INDEX`/`ALTER TABLE` output, no errors. Verify with `psql "$DATABASE_URL" -c "\d products"` and `\d variant_enums`.

- [ ] **Step 7: Commit**

```bash
git add db/schema.sql src/db.ts test/db.test.ts
git commit -m "add products/variant_enums schema and findOrCreateProduct"
```

---

### Task 4: Gemini client wrapper (`src/gemini.ts`)

**Files:**

- Create: `src/gemini.ts`
- Create: `test/gemini.test.ts`
- Modify: `package.json` (add `@google/genai` dependency)

**Interfaces:**

- Produces: `GeminiClient` interface (`{generateJson(prompt: string, schema: object): Promise<unknown>}`), `createGeminiClient(apiKey: string, model?: string): GeminiClient`. Task 5 and Task 6 depend on the `GeminiClient` type (tests inject a fake; only the CLI `main()` functions use the real `createGeminiClient`).

- [ ] **Step 1: Install the dependency**

```bash
pnpm add @google/genai
```

- [ ] **Step 2: Write the failing test**

```ts
// test/gemini.test.ts
import type { GeminiClient } from '../src/gemini'

// createGeminiClient itself wraps the real SDK and is not unit tested here —
// same precedent as createDbPool/createR2ImageStore/launchBrowser elsewhere
// in this repo. This test just locks down the GeminiClient shape that the
// rest of the pipeline is built against.
function fakeGeminiClient(response: unknown): GeminiClient {
  return {
    generateJson: async () => response,
  }
}

test('a GeminiClient exposes generateJson(prompt, schema) returning parsed data', async () => {
  const client = fakeGeminiClient([{ id: '1', base_model: 'RTX 3060' }])
  const result = await client.generateJson('some prompt', { type: 'array' })
  expect(result).toEqual([{ id: '1', base_model: 'RTX 3060' }])
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test test/gemini.test.ts`
Expected: FAIL — `src/gemini.ts` does not exist yet.

- [ ] **Step 4: Write the implementation**

```ts
// src/gemini.ts
import { GoogleGenAI } from '@google/genai'

export interface GeminiClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
}

export function createGeminiClient(apiKey: string, model = 'gemini-2.5-flash'): GeminiClient {
  const ai = new GoogleGenAI({ apiKey })
  return {
    async generateJson(prompt: string, schema: object): Promise<unknown> {
      const interaction = await ai.interactions.create({
        model,
        input: prompt,
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema,
        },
      })
      return JSON.parse(interaction.output_text)
    },
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test test/gemini.test.ts`
Expected: PASS (1 test)

- [ ] **Step 6: Live smoke-test the real SDK shape (important — do not skip)**

The exact response field name (`interaction.output_text` above) is based on Gemini API docs current as of 2026-08-19, but the SDK's actual TypeScript types are the ground truth. Before trusting `createGeminiClient` in the next tasks:

1. Run `pnpm exec tsc --noEmit` — if `interaction.output_text` doesn't exist on the real SDK's return type, this fails loudly with the actual field name to use instead. Fix `src/gemini.ts` to match.
2. Write and run a one-off throwaway script (not committed) that loads `.env`, calls `createGeminiClient(process.env.FREE_GEMINI_API_KEY!).generateJson('Say hello', { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'] })`, and `console.log`s the result. Confirm it returns real parsed JSON (e.g. `{ greeting: "..." }`), not an error. Delete the script after confirming.

If the shape differs from what's written above (e.g. a different method name than `interactions.create`, or a different response field), fix `src/gemini.ts` and re-run Step 5's test to confirm it still passes against the corrected implementation.

- [ ] **Step 7: Commit**

```bash
git add src/gemini.ts test/gemini.test.ts package.json pnpm-lock.yaml
git commit -m "add Gemini structured-output client wrapper"
```

---

### Task 5: Pass 1 extraction script (`src/extract-products.ts`)

**Files:**

- Create: `src/extract-products.ts`
- Create: `test/extract-products.test.ts`
- Modify: `package.json` (add `"extract-products": "tsx src/extract-products.ts"` script)

**Interfaces:**

- Consumes: `loadListings`/`saveListings` (Task 1), `buildExtractionPrompt`/`EXTRACTION_RESPONSE_SCHEMA` (Task 2), `findOrCreateProduct` (Task 3), `GeminiClient`/`createGeminiClient` (Task 4), `DbClient`/`createDbPool` (existing), `Logger`/`createLogger` (existing).
- Produces: `runProductExtraction(gemini: GeminiClient, db: DbClient, logger: Logger, listings: Record<string, unknown>[], options: {batchSize: number, outputPath: string}): Promise<Record<string, unknown>[]>`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/extract-products.test.ts
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { runProductExtraction } from '../src/extract-products'
import { createLogger } from '../src/logger'
import type { GeminiClient } from '../src/gemini'
import type { DbClient } from '../src/db'

const LOG_PATH = 'test/tmp-extract.log'
const OUT_PATH = 'test/tmp-extract.jsonl'

afterEach(() => {
  for (const p of [LOG_PATH, OUT_PATH]) if (existsSync(p)) rmSync(p)
})

function fakeGemini(response: unknown): GeminiClient {
  return { generateJson: async () => response }
}

function fakeDb(): DbClient {
  const products: { id: number; normalized: string; variantTier: string | null }[] = []
  let nextId = 1
  return {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT')) {
        const [normalized, variantTier] = params as [string, string | null]
        const match = products.find((p) => p.normalized === normalized && p.variantTier === variantTier)
        return { rows: match ? [{ id: match.id }] : [] }
      }
      if (sql.startsWith('INSERT')) {
        const [, normalized, variantTier] = params as [string, string, string | null]
        const id = nextId++
        products.push({ id, normalized, variantTier })
        return { rows: [{ id }] }
      }
      return { rows: [] } // UPDATE listings ...
    },
  }
}

test('assigns product_id to each listing from the batched Gemini response', async () => {
  const gemini = fakeGemini([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'iPhone 13' },
  ])
  const logger = createLogger(LOG_PATH)
  const listings = [
    { id: '1', marketplace_listing_title: 'RTX 3060 for sale' },
    { id: '2', marketplace_listing_title: 'iPhone 13 rush' },
  ]

  const result = await runProductExtraction(gemini, fakeDb(), logger, listings, { batchSize: 25, outputPath: OUT_PATH })

  expect(result[0].product_id).toBe(1)
  expect(result[1].product_id).toBe(2)
})

test('two listings with the same base_model get the same product_id', async () => {
  const gemini = fakeGemini([
    { id: '1', base_model: 'RTX 3060' },
    { id: '2', base_model: 'RTX 3060' },
  ])
  const logger = createLogger(LOG_PATH)
  const listings = [
    { id: '1', marketplace_listing_title: 'RTX 3060 for sale' },
    { id: '2', marketplace_listing_title: 'RTX 3060 OC' },
  ]

  const result = await runProductExtraction(gemini, fakeDb(), logger, listings, { batchSize: 25, outputPath: OUT_PATH })

  expect(result[0].product_id).toBe(result[1].product_id)
})

test('listings that already have a product_id are excluded from the batch sent to Gemini', async () => {
  let promptedIds: string[] = []
  const gemini: GeminiClient = {
    generateJson: async (prompt: string) => {
      promptedIds = [...prompt.matchAll(/\[id: (\S+)\]/g)].map((m) => m[1])
      return [{ id: '2', base_model: 'iPhone 13' }]
    },
  }
  const logger = createLogger(LOG_PATH)
  const listings = [
    { id: '1', marketplace_listing_title: 'Already done', product_id: 99 },
    { id: '2', marketplace_listing_title: 'iPhone 13 rush' },
  ]

  await runProductExtraction(gemini, fakeDb(), logger, listings, { batchSize: 25, outputPath: OUT_PATH })

  expect(promptedIds).toEqual(['2'])
})

test('a malformed batch response is logged and skipped, without crashing the run', async () => {
  const gemini = fakeGemini({ not: 'an array' })
  const logger = createLogger(LOG_PATH)
  const listings = [{ id: '1', marketplace_listing_title: 'RTX 3060' }]

  const result = await runProductExtraction(gemini, fakeDb(), logger, listings, { batchSize: 25, outputPath: OUT_PATH })

  expect(result[0].product_id).toBeUndefined()
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[ERROR]')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test test/extract-products.test.ts`
Expected: FAIL — `src/extract-products.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// src/extract-products.ts
import { existsSync } from 'node:fs'
import type { Logger } from './logger'
import { createLogger } from './logger'
import type { GeminiClient } from './gemini'
import { createGeminiClient } from './gemini'
import type { DbClient } from './db'
import { createDbPool, findOrCreateProduct } from './db'
import { loadListings, saveListings } from './jsonl'
import { buildExtractionPrompt, EXTRACTION_RESPONSE_SCHEMA } from './products'
import type { ExtractionInput } from './products'

export interface ExtractionOptions {
  batchSize: number
  outputPath: string
}

function toExtractionInput(listing: Record<string, unknown>): ExtractionInput {
  const title = String(listing.marketplace_listing_title ?? listing.custom_title ?? '')
  const description = String((listing.redacted_description as { text?: string } | undefined)?.text ?? '')
  return { id: String(listing.id), title, description }
}

export async function runProductExtraction(
  gemini: GeminiClient,
  db: DbClient,
  logger: Logger,
  listings: Record<string, unknown>[],
  options: ExtractionOptions,
): Promise<Record<string, unknown>[]> {
  const pending = listings.filter((l) => !l.product_id)
  logger.info(`${listings.length} total listings, ${pending.length} pending product extraction`)

  for (let i = 0; i < pending.length; i += options.batchSize) {
    const batch = pending.slice(i, i + options.batchSize)
    const prompt = buildExtractionPrompt(batch.map(toExtractionInput))
    const raw = await gemini.generateJson(prompt, EXTRACTION_RESPONSE_SCHEMA)

    if (!Array.isArray(raw)) {
      logger.error(`batch starting at ${i}: unexpected response shape (not an array), skipping batch`)
      continue
    }

    for (const item of raw as { id?: unknown; base_model?: unknown }[]) {
      if (typeof item.id !== 'string' || typeof item.base_model !== 'string') continue
      const listing = listings.find((l) => String(l.id) === item.id)
      if (!listing) continue

      const productId = await findOrCreateProduct(db, item.base_model, null)
      listing.product_id = productId
      await db.query('UPDATE listings SET product_id = $1 WHERE id = $2', [productId, item.id])
      logger.info(`listing ${item.id} -> product ${productId} (${item.base_model})`)
    }
    saveListings(options.outputPath, listings)
  }

  return listings
}

async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const apiKey = process.env.FREE_GEMINI_API_KEY
  if (!apiKey) throw new Error('FREE_GEMINI_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — product extraction requires Postgres')

  const logger = createLogger('data/extract-products.log')
  const gemini = createGeminiClient(apiKey)
  const pool = createDbPool(dbUrl)
  const listings = loadListings('data/listings.jsonl')

  try {
    await runProductExtraction(gemini, pool, logger, listings, { batchSize: 25, outputPath: 'data/listings.jsonl' })
  } finally {
    await pool.end()
  }
  logger.info('product extraction complete')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test test/extract-products.test.ts`
Expected: PASS (4 tests)

Run: `pnpm test` (full suite) and `pnpm exec tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 5: Add the npm script**

In `package.json`'s `"scripts"`, add:

```json
"extract-products": "tsx src/extract-products.ts"
```

- [ ] **Step 6: Commit**

```bash
git add src/extract-products.ts test/extract-products.test.ts package.json
git commit -m "add Pass 1 product extraction script"
```

---

### Task 6: Pass 2 variant classification script (`src/variant-classify.ts`)

**Files:**

- Modify: `src/products.ts` (add `buildVariantSchema`, `buildVariantPrompt`)
- Modify: `test/products.test.ts` (add tests for the above)
- Create: `src/variant-classify.ts`
- Create: `test/variant-classify.test.ts`
- Modify: `package.json` (add `"variant-classify": "tsx src/variant-classify.ts"` script)

**Interfaces:**

- Consumes: everything Task 5 consumes, plus reads the `variant_enums` table (Task 3's schema).
- Produces: `runVariantClassification(gemini: GeminiClient, db: DbClient, logger: Logger, listings: Record<string, unknown>[], baseModel: string, enumValues: string[], productId: number, options: {outputPath: string}): Promise<Record<string, unknown>[]>`.

- [ ] **Step 1: Write the failing tests for the prompt/schema builders**

```ts
// append to test/products.test.ts
import { buildVariantSchema, buildVariantPrompt } from '../src/products'

test('buildVariantSchema constrains variant_tier to exactly the given enum values', () => {
  const schema = buildVariantSchema(['Reference/Founders Edition', 'Custom AIB/OC', 'Unknown'])
  expect(schema.items.properties.variant_tier.enum).toEqual(['Reference/Founders Edition', 'Custom AIB/OC', 'Unknown'])
  expect(schema.items.required).toEqual(['id', 'variant_tier'])
})

test('buildVariantPrompt names the base model, lists the enum values, and lists each listing', () => {
  const prompt = buildVariantPrompt(
    'RTX 3060',
    ['Reference/Founders Edition', 'Custom AIB/OC'],
    [{ id: '1', title: 'RTX 3060 OC Asus', description: 'Factory overclocked' }],
  )

  expect(prompt).toContain('RTX 3060')
  expect(prompt).toContain('"Reference/Founders Edition"')
  expect(prompt).toContain('"Custom AIB/OC"')
  expect(prompt).toContain('[id: 1] title: "RTX 3060 OC Asus"')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test test/products.test.ts`
Expected: FAIL — `buildVariantSchema`/`buildVariantPrompt` not exported yet.

- [ ] **Step 3: Add the implementation to `src/products.ts`**

```ts
// append to src/products.ts
export function buildVariantSchema(enumValues: string[]) {
  return {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        variant_tier: { type: 'string', enum: enumValues },
      },
      required: ['id', 'variant_tier'],
    },
  } as const
}

export function buildVariantPrompt(baseModel: string, enumValues: string[], listings: ExtractionInput[]): string {
  const lines = listings.map(formatListingLine).join('\n')
  const tiers = enumValues.map((v) => `- "${v}"`).join('\n')
  return `Classify each ${baseModel} listing below by variant tier, based on its title/description:
${tiers}

Listings:
${lines}`
}
```

`buildVariantPrompt` reuses the module-local `formatListingLine` helper defined in Task 2 — since both live in `src/products.ts`, no export or signature change is needed.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test test/products.test.ts`
Expected: PASS (all tests, including the 2 new ones)

- [ ] **Step 5: Write the failing tests for `runVariantClassification`**

```ts
// test/variant-classify.test.ts
import { existsSync, rmSync } from 'node:fs'
import { runVariantClassification } from '../src/variant-classify'
import { createLogger } from '../src/logger'
import type { GeminiClient } from '../src/gemini'
import type { DbClient } from '../src/db'

const LOG_PATH = 'test/tmp-variant.log'
const OUT_PATH = 'test/tmp-variant.jsonl'

afterEach(() => {
  for (const p of [LOG_PATH, OUT_PATH]) if (existsSync(p)) rmSync(p)
})

function fakeDb(startId: number): DbClient {
  const products: { id: number; normalized: string; variantTier: string | null }[] = []
  let nextId = startId
  return {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT')) {
        const [normalized, variantTier] = params as [string, string | null]
        const match = products.find((p) => p.normalized === normalized && p.variantTier === variantTier)
        return { rows: match ? [{ id: match.id }] : [] }
      }
      if (sql.startsWith('INSERT')) {
        const [, normalized, variantTier] = params as [string, string, string | null]
        const id = nextId++
        products.push({ id, normalized, variantTier })
        return { rows: [{ id }] }
      }
      return { rows: [] }
    },
  }
}

test('reassigns each targeted listing to a new product_id split by variant_tier', async () => {
  const gemini: GeminiClient = {
    generateJson: async () => [
      { id: '1', variant_tier: 'Custom AIB/OC' },
      { id: '2', variant_tier: 'Reference/Founders Edition' },
    ],
  }
  const logger = createLogger(LOG_PATH)
  const listings = [
    { id: '1', marketplace_listing_title: 'RTX 3060 OC Asus', product_id: 5 },
    { id: '2', marketplace_listing_title: 'RTX 3060 Founders Edition', product_id: 5 },
    { id: '3', marketplace_listing_title: 'Unrelated listing', product_id: 6 },
  ]

  const result = await runVariantClassification(
    gemini,
    fakeDb(100),
    logger,
    listings,
    'RTX 3060',
    ['Reference/Founders Edition', 'Custom AIB/OC'],
    5,
    { outputPath: OUT_PATH },
  )

  expect(result[0].product_id).not.toBe(5)
  expect(result[1].product_id).not.toBe(5)
  expect(result[0].product_id).not.toBe(result[1].product_id) // different variant tiers -> different products
  expect(result[2].product_id).toBe(6) // untouched, wasn't part of this product
})

test('only sends listings belonging to the target product_id to Gemini', async () => {
  let promptedIds: string[] = []
  const gemini: GeminiClient = {
    generateJson: async (prompt: string) => {
      promptedIds = [...prompt.matchAll(/\[id: (\S+)\]/g)].map((m) => m[1])
      return [{ id: '1', variant_tier: 'Unknown' }]
    },
  }
  const logger = createLogger(LOG_PATH)
  const listings = [
    { id: '1', marketplace_listing_title: 'RTX 3060', product_id: 5 },
    { id: '2', marketplace_listing_title: 'Something else', product_id: 6 },
  ]

  await runVariantClassification(gemini, fakeDb(100), logger, listings, 'RTX 3060', ['Unknown'], 5, {
    outputPath: OUT_PATH,
  })

  expect(promptedIds).toEqual(['1'])
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm test test/variant-classify.test.ts`
Expected: FAIL — `src/variant-classify.ts` does not exist yet.

- [ ] **Step 7: Write the implementation**

```ts
// src/variant-classify.ts
import { existsSync } from 'node:fs'
import type { Logger } from './logger'
import { createLogger } from './logger'
import type { GeminiClient } from './gemini'
import { createGeminiClient } from './gemini'
import type { DbClient } from './db'
import { createDbPool, findOrCreateProduct } from './db'
import { loadListings, saveListings } from './jsonl'
import { buildVariantPrompt, buildVariantSchema } from './products'
import type { ExtractionInput } from './products'

export interface VariantClassifyOptions {
  outputPath: string
}

function toExtractionInput(listing: Record<string, unknown>): ExtractionInput {
  const title = String(listing.marketplace_listing_title ?? listing.custom_title ?? '')
  const description = String((listing.redacted_description as { text?: string } | undefined)?.text ?? '')
  return { id: String(listing.id), title, description }
}

export async function runVariantClassification(
  gemini: GeminiClient,
  db: DbClient,
  logger: Logger,
  listings: Record<string, unknown>[],
  baseModel: string,
  enumValues: string[],
  productId: number,
  options: VariantClassifyOptions,
): Promise<Record<string, unknown>[]> {
  const targets = listings.filter((l) => l.product_id === productId)
  logger.info(`${targets.length} listings under product ${productId} (${baseModel}) to classify`)
  if (targets.length === 0) return listings

  const prompt = buildVariantPrompt(baseModel, enumValues, targets.map(toExtractionInput))
  const schema = buildVariantSchema(enumValues)
  const raw = await gemini.generateJson(prompt, schema)

  if (!Array.isArray(raw)) {
    logger.error(`unexpected response shape for product ${productId} (${baseModel}), skipping`)
    return listings
  }

  for (const item of raw as { id?: unknown; variant_tier?: unknown }[]) {
    if (typeof item.id !== 'string' || typeof item.variant_tier !== 'string') continue
    const listing = listings.find((l) => String(l.id) === item.id)
    if (!listing) continue

    const newProductId = await findOrCreateProduct(db, baseModel, item.variant_tier)
    listing.product_id = newProductId
    await db.query('UPDATE listings SET product_id = $1 WHERE id = $2', [newProductId, item.id])
    logger.info(`listing ${item.id} -> product ${newProductId} (${baseModel}, ${item.variant_tier})`)
  }
  saveListings(options.outputPath, listings)

  return listings
}

async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const apiKey = process.env.FREE_GEMINI_API_KEY
  if (!apiKey) throw new Error('FREE_GEMINI_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env')

  const logger = createLogger('data/variant-classify.log')
  const gemini = createGeminiClient(apiKey)
  const pool = createDbPool(dbUrl)
  const listings = loadListings('data/listings.jsonl')

  try {
    const enumsResult = (await pool.query('SELECT base_model_normalized, enum_values FROM variant_enums', [])) as {
      rows: { base_model_normalized: string; enum_values: string[] }[]
    }
    const productsResult = (await pool.query(
      'SELECT id, base_model, base_model_normalized FROM products WHERE variant_tier IS NULL',
      [],
    )) as { rows: { id: number; base_model: string; base_model_normalized: string }[] }

    for (const enumRow of enumsResult.rows) {
      const product = productsResult.rows.find((p) => p.base_model_normalized === enumRow.base_model_normalized)
      if (!product) {
        logger.warn(
          `variant_enums row for "${enumRow.base_model_normalized}" has no matching un-split product, skipping`,
        )
        continue
      }
      await runVariantClassification(
        gemini,
        pool,
        logger,
        listings,
        product.base_model,
        enumRow.enum_values,
        product.id,
        {
          outputPath: 'data/listings.jsonl',
        },
      )
    }
  } finally {
    await pool.end()
  }
  logger.info('variant classification complete')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm test test/variant-classify.test.ts`
Expected: PASS (2 tests)

Run: `pnpm test` (full suite) and `pnpm exec tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 9: Add the npm script**

In `package.json`'s `"scripts"`, add:

```json
"variant-classify": "tsx src/variant-classify.ts"
```

- [ ] **Step 10: Commit**

```bash
git add src/products.ts test/products.test.ts src/variant-classify.ts test/variant-classify.test.ts package.json
git commit -m "add Pass 2 variant classification script"
```

---

## After this plan is done

- Run `pnpm run extract-products` once to assign `base_model`/`product_id` to all 997 existing listings.
- Check the resulting `products` table (`psql "$DATABASE_URL" -c "SELECT base_model, count(*) FROM products p JOIN listings l ON l.product_id = p.id GROUP BY base_model ORDER BY count(*) DESC;"`) to see what real product diversity looks like.
- The dashboard (separate plan) is what lets you browse that list and curate `variant_enums` rows without hand-writing SQL — `pnpm run variant-classify` picks those up automatically once they exist.
