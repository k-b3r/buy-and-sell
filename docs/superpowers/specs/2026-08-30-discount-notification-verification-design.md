# Discount Notification Verification — Design

**Status:** draft, pending review.

**Goal:** Gate `discount_notifications` rows (see the 2026-08-30-ish addition to
`db/schema.sql`, built earlier this session) behind an AI-judged verification
pass before the bell/toast ever show them — so a notification means "an LLM
looked at this specific listing, right now, with fresh market data, and
agrees it's a real, meaningfully-profitable deal," not just "a stale
statistical median said 30%+."

## Why this scope, why now

The existing pipeline (`detectAndRecordDiscountNotifications`, wired into
`extract-products.ts`) is a cheap SQL-only signal: it flags a listing the
moment it gets a `product_id`, based on the product's clean median at that
exact instant. That's fast and free, but it's also naive — a generic
`base_model` ("GPU", "Laptop"), a stale/thin median, or a listing whose own
described condition (cracked screen, missing parts) fully explains a low
price would all pass that filter today. Per direct discussion, four gates
now sit between "statistically flagged" and "actually notified":

1. Is the product a real, specific, priceable thing (not generic)?
2. Is it still meaningfully cheaper _right now_, against a fresh market
   check, not the stale median?
3. Does the listing's own stated condition/defects still justify that price
   gap, or does it explain the gap away?
4. Is the absolute peso profit worth the effort — a ₱150 item at 50% off
   isn't worth surfacing even though the percentage looks dramatic.

## Architecture

```
detectAndRecordDiscountNotifications (unchanged shape, two new SQL gates)
  -> discount_notifications row, verified_at = NULL ("candidate")
       |
       v
verify-discount-notifications.ts (NEW worker, loops forever like
enrich-products.ts — independent of the dashboard being open at all)
  -> getUnverifiedDiscountCandidates (pending, respects retry backoff)
  -> Check 1: reuse product_enrichment.is_specific_product (no call)
  -> Check 2+3+4 (one Groq call): fresh web price (Tavily -> Exa -> Gemini
     grounding fallback) + listing text -> judges live discount %, condition
     justification, AND re-derived profit >= MIN_PROFIT_PESOS
  -> pass all -> markDiscountNotificationVerified (verified_at set,
     discount_percent/reference_price overwritten with fresh numbers)
  -> definitive fail on any check -> rejectDiscountNotification (DELETE,
     never notified)
  -> transient failure (all providers/Groq errored) -> markDiscountNotificationAttempted
     (stays pending, retried later, backoff via last_verification_attempt_at)
       |
       v
dashboard (near-zero change): getDiscountNotifications /
getUnreadDiscountNotificationCount add `AND verified_at IS NOT NULL` —
bell/toast, already polling every 60s from any page, just start seeing
fewer, pre-verified rows.
```

## 1. Schema — `db/schema.sql`

```sql
ALTER TABLE discount_notifications ADD COLUMN verified_at TIMESTAMPTZ;
ALTER TABLE discount_notifications ADD COLUMN last_verification_attempt_at TIMESTAMPTZ;
ALTER TABLE discount_notifications ADD COLUMN verification_source TEXT;
ALTER TABLE discount_notifications ADD COLUMN verification_reasoning TEXT;

CREATE INDEX IF NOT EXISTS discount_notifications_pending_idx
  ON discount_notifications (last_verification_attempt_at)
  WHERE verified_at IS NULL;
```

`verified_at IS NULL` = pending (invisible to the dashboard). A row is
deleted outright on a definitive rejection — no "rejected" status needed,
since a listing only ever gets one candidate row ever (see the original
table's `UNIQUE (listing_id)`), so there's nothing to leave a tombstone for.

## 2. Two new cheap-stage gates — `detectAndRecordDiscountNotifications`

Existing function (`src/domains/marketplace/storage/listings.ts`) gets one
more constant and one more `WHERE` condition, no structural change:

```ts
const MIN_PROFIT_PESOS = 1000 // adjustable later; not user-configurable yet
```

Final `SELECT` (feeding the `INSERT`) adds:

```sql
AND (clean.median_price - tl.price_amount) >= 1000
```

alongside the existing `discount_percent >= 30`. Filters out low-absolute-
value items (a ₱150 item at 50% off) before a candidate row is even created
— they never reach the paid Tavily/Exa calls in verification at all.

## 3. New client — `src/domains/llm-clients/tavily.ts`

Mirrors `exa.ts`'s shape (plain `fetch`, no SDK):

```ts
export interface TavilyClient {
  search(query: string): Promise<{ answer: string | null; results: { title: string; content: string }[] }>
}

export function createTavilyClient(apiKey: string): TavilyClient
```

`POST https://api.tavily.com/search` with `{ api_key, query, include_answer: true }`.
A non-2xx or empty `results` is treated as "no data" (caller falls through to
Exa). New `TAVILY_API_KEY` in root `.env`. Exported from
`src/domains/llm-clients/index.ts` alongside the existing four clients.

## 4. Storage — `src/domains/marketplace/storage/listings.ts`

```ts
export interface DiscountVerificationCandidate {
  id: number
  listing_id: string
  title: string | null
  description: string | null
  condition: string | null
  price_amount: number
  base_model: string
  is_specific_product: boolean | null // null = enrichment hasn't run yet
}

const VERIFICATION_RETRY_BACKOFF = "interval '1 hour'"

export async function getUnverifiedDiscountCandidates(
  db: DbClient,
  limit: number,
): Promise<DiscountVerificationCandidate[]>

export async function markDiscountNotificationVerified(
  db: DbClient,
  id: number,
  data: { discountPercent: number; referencePrice: number; source: string; reasoning: string },
): Promise<void>

export async function rejectDiscountNotification(db: DbClient, id: number): Promise<void>

export async function markDiscountNotificationAttempted(db: DbClient, id: number): Promise<void>
```

`getUnverifiedDiscountCandidates`'s `WHERE`: `verified_at IS NULL AND
(last_verification_attempt_at IS NULL OR last_verification_attempt_at <
now() - interval '1 hour')` — same resumability idiom as every other
candidate query in this file (`getPriceReviewCandidates`, etc.), plus the
backoff so a stuck transient-failure candidate doesn't re-burn a paid Tavily
call every 5-minute loop tick.

## 5. Verification orchestration — `src/domains/marketplace/discount-verification.ts`

New pure-ish module (fake clients injected, same testing pattern as
`enrich-products.ts`'s Groq call):

```ts
export interface VerificationResult {
  outcome: 'verified' | 'rejected' | 'pending'
  discountPercent?: number
  referencePrice?: number
  source?: string
  reasoning?: string
}

export async function verifyDiscountCandidate(
  candidate: DiscountVerificationCandidate,
  clients: { tavily: TavilyClient; exa: ExaClient; gemini: GeminiClient; groq: GroqClient },
): Promise<VerificationResult>
```

Steps:

1. `is_specific_product === false` → `rejected`. `null`/missing → `pending`
   (enrichment hasn't caught up). `true` → continue.
2. Fetch fresh market text: `tavily.search(query)` where `query` is
   condition-aware — new-retail phrasing if `condition` reads as "New",
   secondhand/resale phrasing otherwise. Empty/errored → try Exa
   (`searchStructured`, loose schema), then Gemini (`generateGroundedText`).
   All three empty/errored → `pending`.
3. One Groq structured call (`buildVerificationPrompt`/
   `VERIFICATION_RESPONSE_SCHEMA`, mirrors `listing_price_review`'s
   object-wrapping-array shape) with: listing title/description/condition/
   price, the fresh web text, and `MIN_PROFIT_PESOS`. Asks for
   `{ still_discounted: boolean, fresh_price_low, fresh_price_high,
condition_justifies_discount: boolean, meets_profit_bar: boolean, reasoning }`.
4. All three booleans true → `verified` (discount % re-derived from
   `fresh_price_low`/`price_amount`). Any false → `rejected`. Malformed/
   errored Groq response → `pending` (same fail-closed-and-retry philosophy
   as the rest of this pipeline).

## 6. New worker — `src/workers/verify-discount-notifications/index.ts`

Same shape as `enrich-products.ts`: own log file, `main()` guarded by the
`process.argv[1] === fileURLToPath(import.meta.url)` entry-point pattern,
loops forever (`LOOP_DELAY_MS = 300000`, re-queries every 5 min so it keeps
working the backlog down with zero dependency on the dashboard being open),
batch size small (e.g. 3 candidates per tick — each one is a real Tavily +
Groq round trip, not a cheap batched call like extraction).

```
pnpm run verify-discount-notifications
```

added to root `package.json`'s scripts, same list as `collect`/
`extract-products`/etc.

## 7. Dashboard — `dashboard/src/lib/queries.ts`

`getDiscountNotifications` and `getUnreadDiscountNotificationCount` each add
`AND dn.verified_at IS NOT NULL` to their existing `WHERE`/base query.
Nothing else changes — same shape, same columns returned (`discount_percent`/
`reference_price` now reflect the fresh verified numbers, transparently).

## Global constraints

- `MIN_PROFIT_PESOS = 1000`, `HIGH_DISCOUNT_THRESHOLD = 30` — both plain
  constants, not user-configurable yet (explicitly deferred).
- Tavily/Exa are real paid-per-call APIs — the retry backoff and the
  cheap-stage profit/percent pre-filter both exist specifically to avoid
  burning cost on candidates unlikely to pass.
- Fail-closed throughout: any ambiguous/erroring state is `pending`
  (retried later), never silently treated as a pass.
- `listings.price_amount` is still never mutated by any of this — only
  `discount_notifications`' own `discount_percent`/`reference_price` are
  overwritten, same "analysis layered alongside source data" pattern as
  `listing_price_review`.
- TDD throughout, matching the rest of this pipeline: storage functions and
  `verifyDiscountCandidate` get fake-client/fake-DB unit tests; the worker's
  loop/entry-point wiring stays untested (matches `enrich-products.ts`'s own
  carve-out).

## Open risks

- Tavily's actual response shape/reliability for Philippine secondhand
  market queries is unverified — same "worth a spot-check on real data
  before trusting broadly" caution as every other LLM-judgment pipeline in
  this codebase.
- A candidate stuck permanently `pending` (e.g. `is_specific_product` never
  gets backfilled because `enrich-products.ts` hasn't reached that product)
  has no forced resolution path yet — acceptable for now since it just means
  "not notified," never a wrong notification.
