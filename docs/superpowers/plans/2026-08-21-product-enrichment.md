# Product Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For every product, gather a description, an explanation of what drives its resale value, and the model's own trained-knowledge price (if it has one) — via a Groq call with no live search — and store it in `product_enrichment`.

**Architecture:** One new client (`src/groq.ts`, mirrors `src/gemini.ts`'s `GeminiClient` shape), one new pure prompt/schema module (`src/enrichment.ts`), two new `src/db.ts` functions, and one new resumable CLI script (`src/enrich-products.ts`) mirroring `extract-products.ts`'s shape. `product_enrichment` (schema already applied — see `db/schema.sql`) is upserted per product, keyed on `product_id`.

**Tech Stack:** Node.js, TypeScript, `groq-sdk` (new dependency), `pg` (existing), Vitest — same as the rest of this repo.

**Spec:** `docs/superpowers/specs/2026-08-21-listing-value-judgment-design.md`

## Global Constraints

- ₱0 budget: use the free-tier Groq key (`FREE_GROQ_API_KEY` in `.env`, already created) and `openai/gpt-oss-120b` — never a paid key.
- No search tool: this call answers from the model's training knowledge only. The prompt says so explicitly.
- Structured JSON output via the SDK's schema mechanism — never free-text-parse a Groq response. If a batch's response doesn't match the expected shape, log and skip that batch rather than crashing the whole run (same "fail closed on the unit that's broken, keep going" philosophy as the rest of this pipeline).
- Resumable: both the candidate-selection query and a re-run must skip products that already have a `product_enrichment` row — never re-enrich.
- TDD throughout — write the failing test before the implementation for every step below.
- This plan builds and tests the pipeline only. Running it against the real ~1,244-product backlog is deliberately deferred to after this plan (see "After this plan is done") — Groq's daily token cap means that run happens separately, later, possibly across more than one day.

---

### Task 1: Groq client wrapper (`src/groq.ts`)

**Files:**
- Create: `src/groq.ts`
- Create: `test/groq.test.ts`
- Modify: `package.json` (add `groq-sdk` dependency)

**Interfaces:**
- Produces: `GroqClient` interface (`{generateJson(prompt: string, schema: object): Promise<unknown>}`), `createGroqClient(apiKey: string, model?: string): GroqClient`. Task 4 (`enrich-products.ts`) depends on the `GroqClient` type (its tests inject a fake; only the CLI `main()` uses the real `createGroqClient`).

- [ ] **Step 1: Install the dependency**

```bash
pnpm add groq-sdk
```

- [ ] **Step 2: Write the failing test**

```ts
// test/groq.test.ts
import type { GroqClient } from '../src/groq'

// createGroqClient itself wraps the real SDK and is not unit tested here —
// same precedent as createGeminiClient/createDbPool elsewhere in this repo.
// This test just locks down the GroqClient shape the rest of the pipeline
// is built against.
test('a GroqClient exposes generateJson(prompt, schema) returning parsed data', async () => {
  const client: GroqClient = {
    generateJson: async () => ({ results: [{ id: '1', description: 'x' }] }),
  }
  const result = await client.generateJson('some prompt', { type: 'object' })
  expect(result).toEqual({ results: [{ id: '1', description: 'x' }] })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test test/groq.test.ts`
Expected: FAIL — `src/groq.ts` does not exist yet.

- [ ] **Step 4: Write the implementation**

```ts
// src/groq.ts
import Groq from 'groq-sdk'

export interface GroqClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
}

export function createGroqClient(apiKey: string, model = 'openai/gpt-oss-120b'): GroqClient {
  const client = new Groq({ apiKey })
  return {
    async generateJson(prompt: string, schema: object): Promise<unknown> {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            strict: true,
            schema,
          },
        },
      })
      const content = response.choices[0]?.message?.content
      if (!content) {
        throw new Error('Groq response contained no content')
      }
      return JSON.parse(content)
    },
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test test/groq.test.ts`
Expected: PASS (1 test)

- [ ] **Step 6: Live smoke-test the real SDK shape (important — do not skip)**

The exact response field names above (`response.choices[0].message.content`, `response_format.json_schema.{name,strict,schema}`) are based on `groq-sdk` documentation current as of 2026-08-21, but the SDK's actual TypeScript types are the ground truth. Before trusting `createGroqClient` in Task 4:

1. Run `pnpm exec tsc --noEmit` — if any field above doesn't exist on the real SDK's return type, this fails loudly with the actual field name to use instead. Fix `src/groq.ts` to match.
2. Write and run a one-off throwaway script (not committed) that loads `.env` and calls:
   ```ts
   createGroqClient(process.env.FREE_GROQ_API_KEY!).generateJson(
     'Say hello',
     {
       type: 'object',
       properties: { greeting: { type: 'string' } },
       required: ['greeting'],
       additionalProperties: false,
     },
   )
   ```
   `console.log` the result. Confirm it returns real parsed JSON (e.g. `{ greeting: "..." }`), not an error. Delete the script after confirming.

If the shape differs from what's written above (a different method name, a different response field, or the strict-mode schema requirements rejecting the call — e.g. `additionalProperties: false` or every property needing to be in `required`), fix `src/groq.ts` and re-run Step 5's test to confirm it still passes against the corrected implementation.

- [ ] **Step 7: Commit**

```bash
git add src/groq.ts test/groq.test.ts package.json pnpm-lock.yaml
git commit -m "add Groq structured-output client wrapper"
```

---

### Task 2: Enrichment prompt/schema builder (`src/enrichment.ts`)

**Files:**
- Create: `src/enrichment.ts`
- Create: `test/enrichment.test.ts`

**Interfaces:**
- Produces: `EnrichmentCandidate` type (`{id: number, base_model: string, variant_tier: string | null, sibling_variants: string[]}`), `buildEnrichmentPrompt(products: EnrichmentCandidate[]): string`, `ENRICHMENT_RESPONSE_SCHEMA` (const). Task 3 (`getEnrichmentCandidates`'s return type) and Task 4 (`enrich-products.ts`) both consume these.

- [ ] **Step 1: Write the failing test**

```ts
// test/enrichment.test.ts
import { buildEnrichmentPrompt, ENRICHMENT_RESPONSE_SCHEMA } from '../src/enrichment'
import type { EnrichmentCandidate } from '../src/enrichment'

test('buildEnrichmentPrompt includes each product id/label, and sibling variants only when present', () => {
  const products: EnrichmentCandidate[] = [
    {
      id: 363,
      base_model: 'iPhone 12',
      variant_tier: 'Mini',
      sibling_variants: ['(base, no variant)', 'Pro', 'Pro Max'],
    },
    { id: 17, base_model: 'RTX 2060', variant_tier: null, sibling_variants: [] },
  ]

  const prompt = buildEnrichmentPrompt(products)

  expect(prompt).toContain(
    '[id: 363] iPhone 12 (Mini) — other tracked variants of this base model: (base, no variant), Pro, Pro Max',
  )
  expect(prompt).toContain('[id: 17] RTX 2060')
  expect(prompt).not.toContain('RTX 2060 —')
})

test('ENRICHMENT_RESPONSE_SCHEMA requires a results array with all six fields per item', () => {
  expect(ENRICHMENT_RESPONSE_SCHEMA.type).toBe('object')
  expect(ENRICHMENT_RESPONSE_SCHEMA.required).toEqual(['results'])
  expect(ENRICHMENT_RESPONSE_SCHEMA.properties.results.items.required).toEqual([
    'id',
    'description',
    'value_drivers',
    'has_trained_price_knowledge',
    'trained_price_low',
    'trained_price_high',
  ])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/enrichment.test.ts`
Expected: FAIL — `src/enrichment.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/enrichment.ts
export interface EnrichmentCandidate {
  id: number
  base_model: string
  variant_tier: string | null
  sibling_variants: string[]
}

function formatProductLine(p: EnrichmentCandidate): string {
  const label = p.variant_tier ? `${p.base_model} (${p.variant_tier})` : p.base_model
  const siblings =
    p.sibling_variants.length > 0
      ? ` — other tracked variants of this base model: ${p.sibling_variants.join(', ')}`
      : ''
  return `[id: ${p.id}] ${label}${siblings}`
}

export function buildEnrichmentPrompt(products: EnrichmentCandidate[]): string {
  const lines = products.map(formatProductLine).join('\n')
  return `For each product below (identified by base model / variant), provide:
- description: a concise description of what this product is (2-3 sentences)
- value_drivers: what affects this specific product's resale value - condition
  factors, common defects/wear points, meaningful spec or variant differences, what
  separates a well-priced unit from an overpriced one. Where "other tracked variants"
  are listed, write value_drivers specific to THIS variant, not the whole family -
  say how it differs from those siblings where that's relevant to value, not a
  generic description that could apply to any of them.
- has_trained_price_knowledge: true only if you have specific knowledge of this
  product's typical secondhand price from your training data, not a generic guess
- trained_price_low / trained_price_high: if has_trained_price_knowledge is true,
  your best estimate of the typical secondhand price range in PHP (Philippines) as
  of your training data; null otherwise

Do not search - answer only from what you already know. If you don't recognize this
specific product or have no confident price knowledge, set has_trained_price_knowledge
to false and leave the price fields null - do not guess.

Products:
${lines}`
}

export const ENRICHMENT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          value_drivers: { type: 'string' },
          has_trained_price_knowledge: { type: 'boolean' },
          trained_price_low: { type: ['number', 'null'] },
          trained_price_high: { type: ['number', 'null'] },
        },
        required: [
          'id',
          'description',
          'value_drivers',
          'has_trained_price_knowledge',
          'trained_price_low',
          'trained_price_high',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/enrichment.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/enrichment.ts test/enrichment.test.ts
git commit -m "add product enrichment prompt/schema builder"
```

---

### Task 3: `product_enrichment` DB layer (`getEnrichmentCandidates`, `upsertProductEnrichment`)

**Files:**
- Modify: `src/db.ts`
- Modify: `test/db.test.ts`

**Interfaces:**
- Consumes: `EnrichmentCandidate` from `src/enrichment.ts` (Task 2), `DbClient` (already in `src/db.ts`).
- Produces: `getEnrichmentCandidates(db: DbClient): Promise<EnrichmentCandidate[]>`, `EnrichmentData` type (`{description: string, valueDrivers: string, hasTrainedPriceKnowledge: boolean, trainedPriceLow: number | null, trainedPriceHigh: number | null}`), `upsertProductEnrichment(db: DbClient, productId: number, data: EnrichmentData, model: string): Promise<void>`. Task 4 calls both.

The `product_enrichment` table already exists in `db/schema.sql` and has been applied to the real database — no migration step in this task.

- [ ] **Step 1: Write the failing tests**

```ts
// append to test/db.test.ts
import { getEnrichmentCandidates, upsertProductEnrichment } from '../src/db'

test('getEnrichmentCandidates returns products without an enrichment row, with sibling variant names', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return {
        rows: [
          {
            id: 363,
            base_model: 'iPhone 12',
            variant_tier: 'Mini',
            sibling_variants: ['(base, no variant)', 'Pro', 'Pro Max'],
          },
          { id: 17, base_model: 'RTX 2060', variant_tier: null, sibling_variants: [] },
        ],
      }
    },
  }

  const result = await getEnrichmentCandidates(db)

  expect(calls[0].sql).toContain('NOT EXISTS')
  expect(calls[0].sql).toContain('product_enrichment')
  expect(result).toEqual([
    {
      id: 363,
      base_model: 'iPhone 12',
      variant_tier: 'Mini',
      sibling_variants: ['(base, no variant)', 'Pro', 'Pro Max'],
    },
    { id: 17, base_model: 'RTX 2060', variant_tier: null, sibling_variants: [] },
  ])
})

test('upsertProductEnrichment inserts with PHP currency derived when a trained price is known', async () => {
  const { db, calls } = mockDb()

  await upsertProductEnrichment(
    db,
    363,
    {
      description: 'desc',
      valueDrivers: 'drivers',
      hasTrainedPriceKnowledge: true,
      trainedPriceLow: 9000,
      trainedPriceHigh: 13000,
    },
    'openai/gpt-oss-120b',
  )

  expect(calls[0].sql).toMatch(/^INSERT INTO product_enrichment/)
  expect(calls[0].sql).toContain('ON CONFLICT (product_id) DO UPDATE')
  expect(calls[0].params).toEqual([363, 'desc', 'drivers', true, 9000, 13000, 'PHP', 'openai/gpt-oss-120b'])
})

test('upsertProductEnrichment stores null currency when no trained price is known', async () => {
  const { db, calls } = mockDb()

  await upsertProductEnrichment(
    db,
    17,
    {
      description: 'desc',
      valueDrivers: 'drivers',
      hasTrainedPriceKnowledge: false,
      trainedPriceLow: null,
      trainedPriceHigh: null,
    },
    'openai/gpt-oss-120b',
  )

  expect(calls[0].params).toEqual([17, 'desc', 'drivers', false, null, null, null, 'openai/gpt-oss-120b'])
})
```

Note: `mockDb()` is the helper already defined near the top of `test/db.test.ts` — reuse it, don't redefine it.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/db.test.ts`
Expected: FAIL — `getEnrichmentCandidates`/`upsertProductEnrichment` are not exported from `src/db.ts`.

- [ ] **Step 3: Write minimal implementation**

In `src/db.ts`, add:

```ts
import type { EnrichmentCandidate } from './enrichment'

export async function getEnrichmentCandidates(db: DbClient): Promise<EnrichmentCandidate[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier,
       COALESCE(
         (SELECT array_agg(DISTINCT COALESCE(p2.variant_tier, '(base, no variant)'))
          FROM products p2
          WHERE p2.base_model_normalized = p.base_model_normalized AND p2.id != p.id),
         ARRAY[]::text[]
       ) as sibling_variants
     FROM products p
     WHERE NOT EXISTS (SELECT 1 FROM product_enrichment e WHERE e.product_id = p.id)
     ORDER BY p.id`,
    [],
  )) as { rows: EnrichmentCandidate[] }
  return result.rows
}

export interface EnrichmentData {
  description: string
  valueDrivers: string
  hasTrainedPriceKnowledge: boolean
  trainedPriceLow: number | null
  trainedPriceHigh: number | null
}

export async function upsertProductEnrichment(
  db: DbClient,
  productId: number,
  data: EnrichmentData,
  model: string,
): Promise<void> {
  const trainedPriceCurrency = data.trainedPriceLow !== null ? 'PHP' : null
  await db.query(
    `INSERT INTO product_enrichment
       (product_id, description, value_drivers, has_trained_price_knowledge, trained_price_low, trained_price_high, trained_price_currency, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (product_id) DO UPDATE SET
       description = EXCLUDED.description,
       value_drivers = EXCLUDED.value_drivers,
       has_trained_price_knowledge = EXCLUDED.has_trained_price_knowledge,
       trained_price_low = EXCLUDED.trained_price_low,
       trained_price_high = EXCLUDED.trained_price_high,
       trained_price_currency = EXCLUDED.trained_price_currency,
       model = EXCLUDED.model,
       checked_at = now()`,
    [
      productId,
      data.description,
      data.valueDrivers,
      data.hasTrainedPriceKnowledge,
      data.trainedPriceLow,
      data.trainedPriceHigh,
      trainedPriceCurrency,
      model,
    ],
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/db.test.ts`
Expected: PASS (all `db.test.ts` tests, including the 3 new ones)

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts test/db.test.ts
git commit -m "add product_enrichment candidate query and upsert"
```

---

### Task 4: Product enrichment script (`src/enrich-products.ts`)

**Files:**
- Create: `src/enrich-products.ts`
- Create: `test/enrich-products.test.ts`
- Modify: `package.json` (add `"enrich-products": "tsx src/enrich-products.ts"` script)

**Interfaces:**
- Consumes: `getEnrichmentCandidates`/`upsertProductEnrichment`/`EnrichmentData` (Task 3), `buildEnrichmentPrompt`/`ENRICHMENT_RESPONSE_SCHEMA`/`EnrichmentCandidate` (Task 2), `GroqClient`/`createGroqClient` (Task 1), `DbClient`/`createDbPool` (existing), `Logger`/`createLogger` (existing).
- Produces: `runProductEnrichment(groq: GroqClient, db: DbClient, logger: Logger, candidates: EnrichmentCandidate[]): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/enrich-products.test.ts
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { runProductEnrichment } from '../src/enrich-products'
import { createLogger } from '../src/logger'
import type { GroqClient } from '../src/groq'
import type { DbClient } from '../src/db'
import type { EnrichmentCandidate } from '../src/enrichment'

const LOG_PATH = 'test/tmp-enrich.log'

afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

function fakeGroq(response: unknown): GroqClient {
  return { generateJson: async () => response }
}

function fakeDb(): { db: DbClient; upserts: unknown[][] } {
  const upserts: unknown[][] = []
  return {
    upserts,
    db: {
      query: async (_sql: string, params: unknown[]) => {
        upserts.push(params)
        return { rows: [] }
      },
    },
  }
}

test('upserts enrichment data for each product in the batch response', async () => {
  const groq = fakeGroq({
    results: [
      {
        id: '363',
        description: 'A compact iPhone.',
        value_drivers: 'Battery health matters most.',
        has_trained_price_knowledge: true,
        trained_price_low: 9000,
        trained_price_high: 13000,
      },
    ],
  })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [
    { id: 363, base_model: 'iPhone 12', variant_tier: 'Mini', sibling_variants: [] },
  ]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(upserts).toHaveLength(1)
  expect(upserts[0]).toEqual([
    363,
    'A compact iPhone.',
    'Battery health matters most.',
    true,
    9000,
    13000,
    'PHP',
    'openai/gpt-oss-120b',
  ])
})

test('has_trained_price_knowledge false with no price fields stores null prices and null currency', async () => {
  const groq = fakeGroq({
    results: [
      {
        id: '17',
        description: 'x',
        value_drivers: 'y',
        has_trained_price_knowledge: false,
        trained_price_low: null,
        trained_price_high: null,
      },
    ],
  })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [{ id: 17, base_model: 'RTX 2060', variant_tier: null, sibling_variants: [] }]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(upserts[0]).toEqual([17, 'x', 'y', false, null, null, null, 'openai/gpt-oss-120b'])
})

test('batches candidates at 35 per Groq call', async () => {
  let callCount = 0
  const groq: GroqClient = {
    generateJson: async () => {
      callCount += 1
      return { results: [] }
    },
  }
  const { db } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = Array.from({ length: 70 }, (_, i) => ({
    id: i + 1,
    base_model: `Product ${i + 1}`,
    variant_tier: null,
    sibling_variants: [],
  }))

  await runProductEnrichment(groq, db, logger, candidates)

  expect(callCount).toBe(2)
})

test('a malformed batch response (no results array) is logged and skipped, without crashing the run', async () => {
  const groq = fakeGroq({ not: 'the right shape' })
  const { db, upserts } = fakeDb()
  const logger = createLogger(LOG_PATH)
  const candidates: EnrichmentCandidate[] = [{ id: 1, base_model: 'X', variant_tier: null, sibling_variants: [] }]

  await runProductEnrichment(groq, db, logger, candidates)

  expect(upserts).toHaveLength(0)
  expect(readFileSync(LOG_PATH, 'utf-8')).toContain('[ERROR]')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test test/enrich-products.test.ts`
Expected: FAIL — `src/enrich-products.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// src/enrich-products.ts
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger } from './logger'
import { createLogger } from './logger'
import type { GroqClient } from './groq'
import { createGroqClient } from './groq'
import type { DbClient } from './db'
import { createDbPool, getEnrichmentCandidates, upsertProductEnrichment } from './db'
import { buildEnrichmentPrompt, ENRICHMENT_RESPONSE_SCHEMA } from './enrichment'
import type { EnrichmentCandidate } from './enrichment'

const BATCH_SIZE = 35
const MODEL = 'openai/gpt-oss-120b'

interface RawEnrichmentItem {
  id?: unknown
  description?: unknown
  value_drivers?: unknown
  has_trained_price_knowledge?: unknown
  trained_price_low?: unknown
  trained_price_high?: unknown
}

export async function runProductEnrichment(
  groq: GroqClient,
  db: DbClient,
  logger: Logger,
  candidates: EnrichmentCandidate[],
): Promise<void> {
  logger.info(`${candidates.length} products to enrich`)

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE)
    const prompt = buildEnrichmentPrompt(batch)
    const raw = (await groq.generateJson(prompt, ENRICHMENT_RESPONSE_SCHEMA)) as { results?: unknown }

    if (!raw || !Array.isArray(raw.results)) {
      logger.error(`batch starting at ${i}: unexpected response shape (no results array), skipping batch`)
      continue
    }

    for (const item of raw.results as RawEnrichmentItem[]) {
      if (
        typeof item.id !== 'string' ||
        typeof item.description !== 'string' ||
        typeof item.value_drivers !== 'string' ||
        typeof item.has_trained_price_knowledge !== 'boolean'
      ) {
        continue
      }
      const candidate = batch.find((c) => String(c.id) === item.id)
      if (!candidate) continue

      const trainedPriceLow = typeof item.trained_price_low === 'number' ? item.trained_price_low : null
      const trainedPriceHigh = typeof item.trained_price_high === 'number' ? item.trained_price_high : null

      await upsertProductEnrichment(
        db,
        candidate.id,
        {
          description: item.description,
          valueDrivers: item.value_drivers,
          hasTrainedPriceKnowledge: item.has_trained_price_knowledge,
          trainedPriceLow,
          trainedPriceHigh,
        },
        MODEL,
      )
      logger.info(`product ${candidate.id} enriched (trained price known: ${item.has_trained_price_knowledge})`)
    }
  }
}

async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const apiKey = process.env.FREE_GROQ_API_KEY
  if (!apiKey) throw new Error('FREE_GROQ_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — product enrichment requires Postgres')

  const logger = createLogger('data/enrich-products.log')
  const groq = createGroqClient(apiKey)
  const pool = createDbPool(dbUrl)

  try {
    const candidates = await getEnrichmentCandidates(pool)
    await runProductEnrichment(groq, pool, logger, candidates)
  } finally {
    await pool.end()
  }
  logger.info('product enrichment complete')
}

// Guard so importing this module (e.g. from tests) doesn't also run main() —
// import.meta.main is unset under tsx, so compare resolved paths instead.
// (extract-products.ts hit this exact bug: importing its exported function
// for tests triggered a live main() run against real credentials.)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test test/enrich-products.test.ts`
Expected: PASS (4 tests)

Run: `pnpm test` (full suite) and `pnpm exec tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 5: Add the npm script**

In `package.json`'s `"scripts"`, add:

```json
"enrich-products": "tsx src/enrich-products.ts"
```

- [ ] **Step 6: Commit**

```bash
git add src/enrich-products.ts test/enrich-products.test.ts package.json
git commit -m "add product enrichment script"
```

---

## After this plan is done

- Do **not** run `pnpm run enrich-products` against the full backlog yet — per the spec's Open Risks, Groq's 200,000 tokens/day cap is well below what enriching all ~1,244 products needs in one day (~250,000+ output tokens minimum), so a full run needs to span at least 2 days.
- Instead, first do a small live check: temporarily limit `getEnrichmentCandidates`'s query with `LIMIT 35` (one batch) or just let the real first batch run, then `psql "$DATABASE_URL" -c "SELECT product_id, description, value_drivers, has_trained_price_knowledge, trained_price_low, trained_price_high FROM product_enrichment LIMIT 5;"` and eyeball quality — per-item description/value-driver quality and whether sibling-variant context actually produced variant-specific text, not family-generic text.
- Once that looks right, let `pnpm run enrich-products` run to completion across as many sessions as the daily token cap requires — it's resumable, so re-running just picks up where the last run left off.
- Phase 2 (per-listing comparison against this data) is explicitly out of scope here — separate future plan, per the spec.
