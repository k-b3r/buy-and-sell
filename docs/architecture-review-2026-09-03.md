# Architecture Review — 2026-09-03

Deepening-opportunity pass over `src/`, `server/`, `dashboard/`. Method: [improve-codebase-architecture](https://github.com/obra/superpowers) skill — explore for friction, apply the deletion test (would deleting/merging the module concentrate complexity, or just move it?) before listing a candidate.

## Clean (no action needed)

- **dashboard `app/api` routes** — consistently thin pass-throughs to `lib/queries.ts` / `cachedQueries.ts`. No duplicated query logic across `app/products`, `app/deals`, `app/listings`, `app/needs-review`, `app/saved`.
- **`server/`** — real thin HTTP adapter over `src/` domain logic (`createDbPool`, storage functions, `checkOneListing` imported directly). Doesn't duplicate DB/LLM clients.

## Candidates

### 1. Retail/secondhand price lookup duplicated wholesale
- **Files:** `src/domains/marketplace/price-lookup.ts` — `lookupRetail` (~188-233), `lookupSecondhand` (~238-287)
- **Problem:** two ~90-line functions, structurally identical Gemini→Exa→Tavily fallback flow, differing only by a `'retail'|'secondhand'` literal and the `PriceCheckSource` tag per stage. The prompt/query builders below (`buildGeminiPrompt`, `buildExaQuery`, `buildTavilyQuery`) already take a `PriceKind` param — the orchestration functions just don't reuse that parameterization.
- **Solution:** one `kind`-parameterized lookup function.
- **Benefit:** deletion test — yes, pure copy-paste, no complexity displaced elsewhere. One place to fix a provider-order or logging bug instead of two.

### 2. Provider-fallback shape hand-rolled a 3rd, independent time
- **Files:** `src/domains/marketplace/discount-verification.ts` `fetchFreshMarketContext` (71-103); compare to #1's two copies.
- **Problem:** same "try providers in order, take first success" shape, written independently a third time — different provider order (Exa→Tavily→Gemini here vs Gemini→Exa→Tavily in `price-lookup.ts`), different error handling (swallowed here vs `logger.warn` there). No shared primitive exists for "try heterogeneous providers, take first non-empty result."
- **Solution:** extract that primitive; have all three call sites use it.
- **Benefit:** deletion test — yes. Stops 3 copies silently drifting in provider order / error semantics.

### 3. Fallback-client loop copied 4x across providers
- **Files:** `src/gemini.ts`, `src/groq.ts`, `src/exa.ts`, `src/openrouter.ts` — each `createFallbackXClient`
- **Problem:** same currentIndex/while-loop/try-catch/permanent-advance shape, ~15-20 lines each, differing only in the exhaustion-error predicate (429 for Gemini/Groq, 402 for Exa, 429-or-402 for OpenRouter). Note: the model-fallback/round-robin/pool layers built on top of Groq's version (`createModelFallbackGroqClient`, `createRoundRobinGroqClient`, `createGroqPool`) are genuinely Groq-specific — leave those, they earn their complexity.
- **Solution:** generic `createFallbackClient<T>(clients, isExhaustedError)`; each provider file supplies only its predicate.
- **Benefit:** deletion test — yes, 4 copies → 1.

### 4. "Clean median" rule hand-transcribed ~6x
- **Files:** `dashboard/src/lib/queries.ts` — `DISCOUNT_SUMMARY_LATERAL`, `notMagnitudeOutlierSql` CTE, `SIBLING_MEDIAN_SQL`, `SOLD_COMP_MEDIAN_SQL`, `PEER_MEDIAN_SQL`, plus a JS reimplementation (`computeMedians`/`median()`) for `getProductDetail`
- **Problem:** same algorithm (raw median → drop values outside 0.1x-10x of it → recompute median) copy-pasted as raw SQL 5x and JS once. File's own comments admit it ("same clean-median approach as X" appears repeatedly) — the sync mechanism is prose, not shared code.
- **Solution:** single source of truth for the ratio/threshold constants and the CTE shape (SQL macro/view, or push the computation to one JS helper both paths call).
- **Benefit:** deletion test — yes, real. A ratio/threshold change today means finding ~6 spots correctly by hand. Same silent-drift risk class CONTEXT.md already documents happening elsewhere in this project (duplicate product consolidation).

### 5. Repost-dedup rule implemented twice, JS + SQL, zero shared code
- **Files:** `dashboard/src/app/products/[id]/repostDetection.ts` (`computeRepostIds`) vs `dashboard/src/lib/queries.ts` `deal_deduped` CTE
- **Problem:** comment at `queries.ts:1438-1442` says it mirrors `repostDetection.ts` — the two are connected only by that comment. Editing one (e.g. fuzzier title matching) silently diverges from the other.
- **Solution:** one canonical repost-identity rule both paths call/generate from.
- **Benefit:** deletion test — yes. Removes risk of products-page and deals-page disagreeing on which listings are "the same repost."

### 6. Three uncoordinated `price_lookup_excluded` writers (softer finding)
- **Files:** `detectGenericBaseModel` (`src/domains/marketplace/generic-products.ts`), `PRICE_INELIGIBLE_CATEGORIES` (`src/utils/flag-price-ineligible/index.ts`), `applyEligibilityFromEnrichment` (`src/domains/marketplace/storage/products.ts`)
- **Problem:** 3 legitimately different signal sources (real-time heuristic, human curation, LLM judgment) converge on one flag, cross-referenced only by comments. No single place answers "why is/isn't product X excluded."
- **Note:** not a clean deletion-test win — these probably should stay separate detectors. A converge point (shared enum of exclusion reasons, or at minimum a doc) would help without merging the detectors themselves.

### 7. Minor: `defaultDriverFactory` copy-pasted verbatim
- **Files:** `server/routes/refresh.ts:18-21`, `server/routes/refreshProduct.ts:18-21`
- **Problem:** identical 4-line function + comment in both files.
- **Benefit:** trivial, real, low-impact.

## Next step
Pick one candidate to design in detail (interface + seam shape) via a grilling pass. Suggested order by leverage: #3 (small, mechanical, unblocks nothing else) → #1/#2 together (same root cause, do in one pass) → #4 → #5 → #6 (doc-only, no code change) → #7.
