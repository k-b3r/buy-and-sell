# real-estate

Turns Facebook Marketplace real-estate listings into structured details (type, price basis, area, tags) with an LLM, and serves them for the real-estate page.

Tables owned: `real_estate_details`, `listing_price_history`. It only reads `listings`, `products` and `categories`.

Must never:

- store ₱/sqm: it is derived at query time
- let a price-history write fail a listing refresh
- let `domain/` read the clock, randomness, env, the network or the DB
