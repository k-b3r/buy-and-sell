# Listing Value Judgment — Design

**Status:** draft, pending review.

**Goal:** For each real (non-generic) product, judge whether each of its listings is a
good deal, adjusted for the condition/defects stated in that specific listing's own
title/description — not just a flat comparison against a price range. Surface the
verdict on the dashboard.

## Why (context from exploration)

Raw min/max/avg pricing (already on the dashboard) ignores condition — a scratched
unit legitimately costs less; that's not automatically a deal signal. A 3-product
live spike (RTX 2060, iPhone 12 Mini, Land Lot) confirmed an LLM reading a listing's
free text against a market anchor catches this correctly (e.g. flagged a listing with
78% battery health as `overpriced` despite a similar price to 97%+ units; flagged a
swap-only/reballed listing with a placeholder price as `insufficient_info` instead of
a fake bargain; flagged the deliberately-generic "Land Lot" product as `is_generic`).

Two API calls are involved and they do different jobs:
- **Grounded market lookup** (needs live web search) — Gemini, already built
  (`src/pricing.ts` + `src/price-lookup.ts`), low volume, resumable.
- **Per-listing judgment** (no search — reasoning over provided text) — moving this to
  **Groq** (`openai/gpt-oss-120b`, free tier: 1,000 req/day / 200,000 tokens/day,
  native strict JSON-schema output), since it's the higher-volume call and Gemini
  cannot combine search grounding with structured JSON output in one request
  (confirmed live — see `src/gemini.ts`'s comment on `generateGroundedText`).

## Architecture

```
products (has a parsed market price)
  -> judge-listings.ts groups that product's un-judged listings
  -> Groq: batched structured judgment call (market range + reasoning as anchor,
           each listing's own title/condition/description as evidence)
  -> listing_value_judgments rows (one per listing)
  -> dashboard: getProductDetail joins verdicts, ListingsView renders a badge
```

Layers on the existing extraction pipeline; doesn't replace it. Two additions to the
existing grounded price-lookup step, one new client, one new script, one new table,
one dashboard change.

## 1. Reasoning-aware grounded price lookup (extends existing code)

`src/pricing.ts`'s `buildPriceLookupPrompt` already produces a response whose full
text is stored (`product_price_history.raw_response`) — real stored examples already
contain decent reasoning ("excluded Pro Max figure, different product"; "128GB
30760-34000, 256GB 34500-38000, combined range"), but this is incidental, not
required by the prompt. Tighten it to require the explanation explicitly:

```
Search for the current secondhand/used market price range in PHP for "${productName}"
in the Philippines, based on real current listings (e.g. Facebook Marketplace,
Carousell, Shopee).

Explain your reasoning: what listings/data points you found, what you excluded and
why (different variant, different condition tier, outlier), and any condition
assumption behind the range (e.g. "typical used condition" vs "like new").

End your response with exactly one line in this exact format, with no extra text
after it:
PRICE_RANGE: <low>-<high> PHP

If you cannot find enough real listings to determine a range, omit that line entirely
instead of guessing.
```

`parsePriceRangeResponse` is unchanged (still parses the trailing line). The
surrounding explanation text is what step 2 reads as the market anchor's reasoning.
Products where this doesn't produce a parseable range are implicitly excluded from
judgment (see candidate selection below) — this, combined with the judgment call's
own `is_generic` flag, is the "not generic" filter, not a hardcoded category list.

## 2. `src/groq.ts` — Groq client wrapper

Mirrors `GeminiClient`'s shape so `src/judge-listings.ts` doesn't care which provider
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

## 3. Schema: `listing_value_judgments`

```sql
CREATE TABLE IF NOT EXISTS listing_value_judgments (
  listing_id TEXT PRIMARY KEY REFERENCES listings(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  verdict TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  estimated_fair_price NUMERIC,
  is_generic_product BOOLEAN NOT NULL DEFAULT false,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listing_value_judgments_product_idx
  ON listing_value_judgments (product_id);
```

**Postgres-only, no JSONL mirror** — deliberate break from this repo's usual
dual-write convention. `data/listings.jsonl` is the scraped source-of-truth mirror;
this table is derived analysis, not scraped data, so it doesn't belong there.

## 4. `src/judge-listings.ts`

Same shape as `extract-products.ts`/`variant-classify.ts`: resumable CLI, own log
file, `main()` guarded by the `process.argv[1] === fileURLToPath(import.meta.url)`
pattern (Task 5 of the extraction plan hit a real bug without this — importing the
module for its exported function ran `main()` as a side effect against live
credentials during `pnpm test`).

**Candidate selection:** products with a parseable market price
(`product_price_history` has a row with a non-null `price_low`/`price_high`) whose
listings don't yet have a `listing_value_judgments` row. Batched per product (all of
one product's un-judged listings in one Groq call, using the product's latest market
price + its `raw_response` reasoning as context) — mirrors `variant-classify.ts`'s
per-product batching, **sub-chunked at a fixed max listings-per-call** (e.g. 15) for
products with more un-judged listings than that, to stay well under Groq's 8,000
TPM cap — a handful of products (e.g. "iPhone 13" has 34 listings) would otherwise
push a single request's token count too high.

**Prompt + schema** (validated in the live spike):

```
You are evaluating second-hand Facebook Marketplace listings in the Philippines for
the product "${productName}".

${marketRangeText ? `Reference market price range found: ${marketRangeText}
Reasoning behind that range: ${marketReasoningText}` : 'No reliable market price range was found for this product.'}

First: is "${productName}" too generic/broad a name to price meaningfully as a single
comparable product (e.g. a bare category like "Laptop", "Land", "Item", or something
whose price depends on unstated specifics like land area/location rather than the
item itself)? Set is_generic accordingly.

Second, for each listing below, judge its value: compare its asking price against the
market range, adjusted for whatever condition or defects are mentioned in its
title/description. A low price WITH a stated defect is not necessarily a deal — a low
price with no stated issue is the real signal. Your own background knowledge of this
product (typical specs, common issues, general depreciation) may inform this
judgment, but the provided market range is the anchor for the number — if your own
sense of the price disagrees strongly with it, say so in the reasoning rather than
silently picking one. Ignore obviously bogus/placeholder prices (e.g. swap-only
listings with a filler price) — mark those insufficient_info.

Listings:
[id: ...] title: "..." condition: "..." price: ₱... desc: "..."
```

```ts
{
  type: 'object',
  properties: {
    is_generic: { type: 'boolean' },
    listings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['great_deal', 'fair', 'overpriced', 'insufficient_info'] },
          reasoning: { type: 'string' },
          estimated_fair_price: { type: 'number', nullable: true },
        },
        required: ['id', 'verdict', 'reasoning'],
      },
    },
  },
  required: ['is_generic', 'listings'],
}
```

Malformed/non-conforming batch response: log + skip (same fail-closed-on-the-broken-
unit philosophy as the rest of this pipeline), even though Groq's strict mode is
supposed to guarantee schema compliance.

## 5. Dashboard surfacing

`dashboard/src/lib/queries.ts`: `getProductDetail` gains a join to
`listing_value_judgments` per listing (verdict, reasoning, estimated_fair_price).
`ListingsView` (both List and Cards views, product detail page) renders a small
verdict badge — reuses `--color-signal` for `great_deal`, a new `--color-warn` token
for `overpriced`, `--color-text-muted` for `fair`/`insufficient_info`.

## Global constraints

- ₱0 budget: `FREE_GROQ_API_KEY` (already created) and the existing
  `FREE_GEMINI_API_KEY` — never a paid key.
- Resumable: listings already in `listing_value_judgments` are skipped.
- Structured JSON output only for the Groq call — never free-text-parsed.
- The Gemini grounded call still can't combine search + structured output; stays
  free-text + trailing-line-parsed, unchanged from the existing pattern.
- TDD throughout: prompt/schema builders, `GroqClient` (fake-injected), the
  orchestration script (fakes, no live calls in tests), and the dashboard query
  change all get Vitest coverage per this repo's existing carve-outs.

## Open risks

- Groq's 200,000 tokens/day cap is the likely real bottleneck, not the 1,000
  requests/day figure — full backlog (~1,244 products) may take a few days,
  resumability is the mitigation, not a fix.
- Grounded-call throttling has been observed as both severe and absent within the
  same two days — unpredictable, same mitigation.
- Products with a market price that's technically parseable but still not truly
  comparable (the `is_generic` flag catches some of this, not all) — worth a spot-
  check pass on a wider sample once this is running, per your own note.

## Out of scope (this pass)

- No dashboard UI to manually re-trigger judgment for a single product (CLI only).
- No historical trend of verdicts over time (table is structured to allow it later
  via re-running, not built now).
