# See and undo pricing exclusions (BUY-36)

## Problem

`products.price_lookup_excluded` hides a product from price lookup forever, with no trace in the dashboard and no undo short of a DB edit. Live 2026-10-08: **6,829 of 10,584 products (65%) are excluded**, under 15 reasons:

| Reason                                | Count | Kind                             |
| ------------------------------------- | ----- | -------------------------------- |
| retail_not_found                      | 1,935 | lookup outcome                   |
| groq_generic                          | 1,901 | judgment (LLM)                   |
| exa_no_result                         | 1,360 | lookup outcome, retired          |
| too_generic                           | 511   | judgment (heuristic / curated)   |
| exa_wide_spread                       | 481   | lookup outcome, retired          |
| real_estate                           | 207   | judgment                         |
| generic_category                      | 175   | judgment, retired                |
| parts_accessory                       | 163   | judgment                         |
| service                               | 32    | judgment                         |
| claude_no_result                      | 26    | lookup outcome, retired          |
| needs_component_pricing               | 26    | judgment (curated)               |
| manual_review                         | 6     | judgment (human)                 |
| exa_low_confidence + 2 dated one-offs | 6     | lookup outcome / manual, retired |

The "lookup outcome" rows (about 3,800) are the likely false exclusions: many were written while Gemini (20/day) or Exa credits were exhausted, so "no price found" says more about quota than about the product.

## Goals

1. See: an exclusion badge with its reason on the product page and product cards.
2. Find: an Excluded view in the product list, grouped by reason with counts.
3. Undo: re-include one product and have it stick.

## Design

### Two kinds of reason, two undo semantics

- **Lookup outcome** (`retail_not_found`, `exa_no_result`, `exa_wide_spread`, `exa_low_confidence`, `claude_no_result`): undo means **retry**. Clear the flag; price lookup picks the product up again. If it fails again it is re-excluded as `retail_not_found`, which is correct.
- **Judgment** (everything else): undo means **override**. Clear the flag and record the override, so the automatic writers stop re-applying it:
  - `applyEligibilityFromEnrichment` (runs every enrich-products lap, would re-add `groq_generic` within minutes),
  - the live heuristic in `ensureProductPriced` (`detectGenericBaseModel`),
  - the curated lists via `flag-price-ineligible`.

### Data

Side table, per the data standard (feature data off the core table):

```sql
CREATE TABLE IF NOT EXISTS price_exclusion_overrides (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  previous_reason TEXT NOT NULL,
  overridden_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Only judgment undos write a row. Every automatic exclusion write in `exclusion.ts` gains `AND NOT EXISTS (SELECT 1 FROM price_exclusion_overrides o WHERE o.product_id = products.id)`. A human `manual_review` exclusion deletes the override (an explicit human decision wins).

### Module and server

All in `src/modules/pricing` (`exclusion.ts` owns the writes, `queries.ts` the reads), exposed through the named-query whitelist / RPC like `excludeProductFromReview`:

- `getExclusionSummary()`: count per reason, plus kind.
- `getExcludedProducts(reason, page)`: paged list for the Excluded view.
- `includeInPricing(productId)`: the undo, choosing retry vs override by the product's reason kind.

### Dashboard

- Product page and `ProductCard`: badge "Pricing excluded: <reason>", tooltip with what the reason means.
- Excluded view: a `/excluded` page (reasons with counts, then products per reason, most listings first), linked from the badge rather than the nav bar, so no page pays an extra settings lookup.
- Product page: "Include in pricing" button.
- Copy for curated reasons: "Curated list: re-applied by flag-price-ineligible unless overridden here" is no longer true once overrides exist; say "Overridden: the curated list won't re-apply it."

### Gate

`pricing.exclusions_ui_enabled = 0` (default: today's behavior, nothing shown). The override guard in the writers ships ungated: with no override rows it changes nothing.

## Out of scope

- Bulk undo by reason (decided 2026-10-08: per product only).
- Renaming legacy reasons in the DB (the UI maps them to labels instead).
- A full audit log of exclusion history (the override row keeps `previous_reason` only).

## Done when

- Badge, Excluded view and per-product undo work behind the setting, with tests for the module functions and the writer guards.
- A judgment undo survives the next enrich-products lap and a `flag-price-ineligible` run (test).
- A lookup-outcome retry re-enters price lookup candidates (test).
