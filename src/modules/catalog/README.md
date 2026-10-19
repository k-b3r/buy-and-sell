# catalog

Turns Facebook Marketplace listings into tracked products (extraction, dedup and merge, enrichment, categories, model-mismatch checks) and serves the product pages of the dashboard.

Tables owned: `products`, `product_enrichment`. It only reads `categories`, `listings`, `listing_price_review`, `saved_listings`, `discount_notifications` and `product_price_history` (pricing's tables), except that it sets `listings.product_id` and re-points `product_price_history` and `discount_notifications` rows to the surviving product when it merges two products.

Must never:

- store a median, discount or secondhand price: pricing derives them at query time
- merge or reassign products without a dry-run path
- let `domain/` read the clock, randomness, env, the network or the DB
