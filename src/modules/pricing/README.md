# pricing

Finds retail and secondhand prices for products, spots deals (sold comps, peer medians, discounts) and runs the price-review, discount-verification and exclusion pipelines behind the products, deals and notifications pages.

Tables owned: `product_price_history`, `listing_price_review`, `discount_notifications`, `product_pricing_triage`, `price_exclusion_overrides`. It is the only writer of the `products` exclusion columns (`price_lookup_excluded`, `price_lookup_excluded_reason`, `price_lookup_review_status`, `price_lookup_review_dismissed_at`). It only reads `listings`, `products`, `categories`, `product_enrichment` and `saved_listings`.

Must never:

- build SQL outside `store/`
- let `domain/` read the clock, randomness, env, the network or the DB, or import `store/` or a mixed root file
- write `products.price_lookup_excluded` outside `store/exclusion.ts`
- turn a provider outage or quota error into a price verdict
