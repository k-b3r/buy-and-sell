# Product Enrichment — Design

**Status:** draft, pending review.

**Goal (this pass):** For each product, gather three things from an LLM's own
knowledge — no live search: a description of what it is, an explanation of what
drives its resale value (condition factors, common defects, meaningful
spec/variant differences), and the model's own price knowledge from training, if it
has any. Store it per product. **Per-listing comparison against this data is
explicitly out of scope for this pass** — that's Phase 2, later, once this data
exists to compare against.

## Why this scope, why now

Earlier exploration (see conversation, and the 3-product live spike: RTX 2060,
iPhone 12 Mini, Land Lot) validated that an LLM reading a listing's free text against
a market anchor produces useful, condition-aware verdicts. But that requires the
anchor to exist first. This pass builds the anchor — product-level data — and
nothing downstream of it yet.

None of the three fields (description, value drivers, trained-knowledge price)
need live search — they're the model's own parametric knowledge. That means this
step doesn't need Gemini's grounding at all, and can run entirely on **Groq**
(`openai/gpt-oss-120b`, free tier: 1,000 req/day / 200,000 tokens/day, native strict
JSON-schema output) — cheaper and higher-quota than Gemini for this job. The
existing live grounded price-lookup (`src/price-lookup.ts`, Gemini, unchanged) is a
**separate, independent signal** that keeps running as-is — this doesn't replace it,
it adds a second, differently-sourced price point alongside it.

## Architecture

```
products (all of them — every product has >=1 listing by construction)
  -> enrich-products.ts batches un-enriched products (base_model + variant_tier only,
     no listings needed at this stage)
  -> Groq: structured batch call, no search tool
  -> product_enrichment rows (one per product, upserted)
```

One new client, one new script, one new table. No dashboard change in this pass
(surfacing this data on the product detail page is straightforward once it exists,
but isn't the current focus — can follow as a small addition once the data's real).

## 1. `src/groq.ts` — Groq client wrapper

Mirrors `GeminiClient`'s shape so orchestration code doesn't care which provider
it's calling:

```ts
export interface GroqClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
}

export function createGroqClient(apiKey: string, model = 'openai/gpt-oss-120b'): GroqClient
```

Package: `groq-sdk` (npm) — exact call shape needs a live smoke-test before trusting
it, same as Task 4's `src/gemini.ts` did (that task's own draft SDK call turned out
wrong and was caught exactly by its smoke-test step). The implementation plan must
include an equivalent smoke-test step here.

## 2. Schema: `product_enrichment`

```sql
CREATE TABLE IF NOT EXISTS product_enrichment (
  product_id INTEGER PRIMARY KEY REFERENCES products(id),
  description TEXT NOT NULL,
  value_drivers TEXT NOT NULL,
  has_trained_price_knowledge BOOLEAN NOT NULL,
  trained_price_low NUMERIC,
  trained_price_high NUMERIC,
  trained_price_currency TEXT,
  model TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`product_id` is the primary key (upsert, not append-only) — unlike
`product_price_history` (which intentionally keeps every check as a trend point
since live market prices move over time), a model's trained knowledge doesn't change
between runs unless the model itself changes. The `model` column records which model
produced the row, so a future model upgrade has a clear signal for which rows are
worth refreshing — not needed now, just cheap to capture.

## 3. `src/enrich-products.ts`

Same resumable-CLI shape as `extract-products.ts`: own log file, `main()` guarded by
the `process.argv[1] === fileURLToPath(import.meta.url)` pattern (required — Task 5
of the extraction plan hit a real bug without this guard, where importing the
module's exported function for tests ran `main()` against live credentials as a
side effect).

**Candidate selection:** every product without a `product_enrichment` row yet —
`SELECT p.id, p.base_model, p.variant_tier FROM products p WHERE NOT EXISTS (SELECT 1
FROM product_enrichment e WHERE e.product_id = p.id)`. No listings are read at this
stage — only `base_model`/`variant_tier` are needed as input.

**Batching:** 25 products per Groq call — same batch size as `extract-products.ts`'s
Pass 1, and this call is lighter per-item than that one (no listing text involved,
just a product name), so 25 stays comfortably under the 8,000 TPM cap.

**Prompt:**

```
For each product below (identified by base model / variant), provide:
- description: a concise description of what this product is (2-3 sentences)
- value_drivers: what affects this specific product's resale value — condition
  factors, common defects/wear points, meaningful spec or variant differences, what
  separates a well-priced unit from an overpriced one
- has_trained_price_knowledge: true only if you have specific knowledge of this
  product's typical secondhand price from your training data, not a generic guess
- trained_price_low / trained_price_high: if has_trained_price_knowledge is true,
  your best estimate of the typical secondhand price range in PHP (Philippines) as
  of your training data; omit otherwise

Do not search — answer only from what you already know. If you don't recognize this
specific product or have no confident price knowledge, set has_trained_price_knowledge
to false and leave the price fields out — do not guess.

Products:
[id: 17] RTX 2060
[id: 363] iPhone 12 (Mini)
...
```

**Schema:**

```ts
{
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      description: { type: 'string' },
      value_drivers: { type: 'string' },
      has_trained_price_knowledge: { type: 'boolean' },
      trained_price_low: { type: 'number', nullable: true },
      trained_price_high: { type: 'number', nullable: true },
    },
    required: ['id', 'description', 'value_drivers', 'has_trained_price_knowledge'],
  },
}
```

Malformed/non-conforming batch response: log + skip (same fail-closed-on-the-broken-
unit philosophy as the rest of this pipeline), even though Groq's strict mode is
supposed to guarantee schema compliance.

## Global constraints

- ₱0 budget: `FREE_GROQ_API_KEY` (already created) — never a paid key.
- Resumable: products already in `product_enrichment` are skipped.
- Structured JSON output only — never free-text-parsed.
- No search tool — this call is explicitly answering from training knowledge only;
  the prompt says so directly, and there's nothing wired up for Groq to search with
  anyway.
- TDD throughout: prompt/schema builder, `GroqClient` (fake-injected), and the
  orchestration script (fakes, no live calls in tests) all get Vitest coverage per
  this repo's existing carve-outs.

## Open risks

- `has_trained_price_knowledge: false` is only as honest as the model's own
  self-assessment — some hallucinated-but-confident price knowledge is possible.
  Worth a spot-check on a sample once this runs, same caution as the rest of this
  effort.
- Groq's 200,000 tokens/day cap likely bottlenecks before the 1,000 requests/day
  figure does, same as previously noted — full backlog (~1,244 products) may take
  a couple of runs across days; resumability handles this, no special handling
  needed.

## Deferred to Phase 2 (not this pass)

Per-listing comparison against this enrichment data, using each listing's own stated
condition/defects — the original motivating idea from this whole exploration — plus
the live grounded price signal (`price-lookup.ts`, already running independently) as
a second anchor. Both exist as real signals once this phase lands; combining them
into per-listing verdicts is future work once product-level data is real and
spot-checked.
