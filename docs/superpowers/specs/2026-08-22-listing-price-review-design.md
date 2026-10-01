# Listing Price Review — Design

**Status:** draft, pending review.

**Goal:** For listings whose recorded price is a statistical outlier against their
product's other listings, determine — by reading the listing's own title and
description — whether it's negotiable, and what its real price (or price range,
for bundle/multi-item listings) actually is. `listings.price_amount` is never
mutated; the real scraped number stays the source of truth always.

## Why this shape

Real data confirmed (see conversation): Facebook has no structured "negotiable"
field — it only ever shows up as free text ("nego", "negotiable", "rush
negotiable"). Facebook does have `min_listing_price`/`max_listing_price` fields for
genuine range-priced listings, but they're unpopulated in our data — the range
signal we need lives in description text (bundle/compilation posts), not that
field. Both problems need text understanding, not a lookup — LLM territory, same
as the enrichment pipeline.

Two independent signals per listing, never coupled: a listing can be a single
fixed price AND negotiable, a genuine range AND not negotiable, etc.

**Two-stage pipeline, cheap filter before the expensive one:**

1. SQL-only, no LLM: flag listings whose price is several magnitudes off their
   product's median. Computed live against the real DB: **140 listings** flagged
   out of 2,051 with a product assigned (~6.8%) — small, bounded scope.
2. LLM (Groq, no search — pure text reading), only on flagged listings: reads
   title + description + the recorded price, returns `is_negotiable` and a real
   `price_low`/`price_high`.

## Architecture

```
listings (price_amount is a statistical outlier for its product, not yet reviewed)
  -> getPriceReviewCandidates (SQL: per-product median + ratio threshold, no LLM)
  -> review-listing-prices.ts batches candidates
  -> Groq: structured batch call
  -> listing_price_review rows (one per listing, upserted)
  -> dashboard: listing views show price/range + a separate "Negotiable" badge
     when a review row exists, unchanged otherwise
```

One new script, one new table, dashboard display changes. Reuses the exact
`GroqClient`/batched-prompt/upsert-table pattern already built for enrichment —
no new infra.

## 1. Schema: `listing_price_review`

```sql
CREATE TABLE IF NOT EXISTS listing_price_review (
  listing_id TEXT PRIMARY KEY REFERENCES listings(id),
  is_negotiable BOOLEAN NOT NULL,
  price_low NUMERIC,
  price_high NUMERIC,
  reasoning TEXT NOT NULL,
  model TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`listing_id` is the primary key (upsert, not append-only) — same reasoning as
`product_enrichment`: a fresh LLM read of the same static text doesn't change
between runs unless the model changes, so there's no trend to preserve.
`listings.price_amount` itself is **never written to by this pipeline** — this
table is purely additive, matching how `product_enrichment`/`product_price_history`
already layer analysis alongside source rows instead of overwriting them.

## 2. Candidate selection (SQL only, no LLM)

```sql
WITH product_medians AS (
  SELECT product_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_amount) AS median_price
  FROM listings
  WHERE product_id IS NOT NULL AND price_amount IS NOT NULL AND price_amount > 0
  GROUP BY product_id
)
SELECT l.id, l.title, l.description, l.price_amount
FROM listings l
JOIN product_medians m ON m.product_id = l.product_id
WHERE l.price_amount IS NOT NULL
  AND (l.price_amount < m.median_price / 10 OR l.price_amount > m.median_price * 10)
  AND NOT EXISTS (SELECT 1 FROM listing_price_review r WHERE r.listing_id = l.id)
```

Threshold: more than 10x off the product's own median in either direction.
Products with only one listing can never flag themselves (a lone listing's price
equals its own median, ratio is always 1). Resumability: the same `NOT EXISTS`
pattern already used for `getEnrichmentCandidates` — reviewed listings are
skipped on future runs; new outliers (from newly-collected listings) are picked
up naturally.

## 3. `src/review-listing-prices.ts`

Same resumable-CLI shape as `enrich-products.ts`/`extract-products.ts`: own log
file, `main()` guarded by the `process.argv[1] === fileURLToPath(import.meta.url)`
entry-point pattern, batched loop, malformed-batch logged-and-skipped rather than
crashing the run.

**Batching:** 35 candidates per Groq call — same batch size as enrichment, and
this call's per-item output is lighter (two numbers, a boolean, one short
sentence — no description/value-drivers paragraph), so it stays comfortably
under the 8,000 TPM cap. At 140 real candidates today, that's 4 batches total —
trivially fits one run, well under both Groq's RPD and TPD caps.

**Prompt:**

```
For each flagged listing below, read its title, description, and the price
Facebook recorded for it, and determine:
- is_negotiable: true if the text indicates the seller is open to negotiation,
  offers, or trade (e.g. "nego", "negotiable", "OBO", "open to swap/offers"),
  false otherwise
- price_low / price_high: your best read of the actual price(s) this listing is
  asking for, based on the text - not just the recorded number, which may be a
  placeholder, a data error, or per-unit/per-sqm pricing that doesn't reflect the
  real total price. If the listing covers multiple items at different prices (a
  bundle/compilation post), price_low/price_high should span that range. If a
  single price is intended, set price_low and price_high to the same value. If no
  real price can be determined at all from the text, set both to null.
- reasoning: one sentence explaining your read

Listings:
[id: ...] title: "..." recorded_price: ₱... desc: "..."
```

**Schema** (object-wrapping-array — the same proven-correct shape as
`ENRICHMENT_RESPONSE_SCHEMA`, since Groq's strict JSON-schema mode requires a
root `object`, not an `array`):

```ts
{
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          is_negotiable: { type: 'boolean' },
          price_low: { type: ['number', 'null'] },
          price_high: { type: ['number', 'null'] },
          reasoning: { type: 'string' },
        },
        required: ['id', 'is_negotiable', 'price_low', 'price_high', 'reasoning'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const
```

Malformed/non-conforming batch response: log + skip, same fail-closed philosophy
as the rest of this pipeline.

## 4. Dashboard

`getProductDetail`'s listings query and `getListingDetail` both gain a `LEFT
JOIN listing_price_review` (mirrors the existing `product_enrichment` join
pattern). Where a review row exists:

- If `price_low !== price_high`: show the range (`₱low–₱high`) instead of the
  flat `price_amount`.
- If `price_low === price_high` and not null: show that single value instead of
  `price_amount`.
- If both null: fall back to showing `price_amount` as today (no real price
  could be determined from the text either — nothing better to show).
- **Independently**, whenever `is_negotiable` is true: show a "Negotiable" badge
  alongside whatever price is displayed — this never replaces the price, and
  applies whether or not `price_low`/`price_high` differ from `price_amount`.

No review row: display is completely unchanged from today.

## Global Constraints

- ₱0 budget: `FREE_GROQ_API_KEY`, `openai/gpt-oss-120b` — never a paid key.
- No search tool — pure text reading, nothing to search for.
- Structured JSON output only — never free-text-parsed.
- `listings.price_amount` is never written to by this pipeline, under any
  circumstance — it is scraped source data, not analysis output.
- Resumable: `getPriceReviewCandidates`'s `NOT EXISTS` is the only skip
  mechanism, same as the enrichment pipeline.
- TDD throughout.

## Open Risks

- Reading a bundle/multi-item listing's real price range correctly from messy
  free text is inherently fuzzy — same caution as the enrichment/judgment work:
  worth a spot-check on a real sample before trusting it broadly.
- 140 is today's flagged count; it will grow as more listings are collected.
  Resumability means future runs only process the delta, not a full re-scan.
