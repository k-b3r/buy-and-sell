# collection

Collects Facebook Marketplace listings through a proxied browser, re-checks them for sold or removed, re-hosts their photos, and serves listing detail and saved listings to the dashboard.

Tables owned: `listings`, `collect_keywords`, `saved_listings`. It only reads `products`, `categories`, `discount_notifications` and `listing_price_review`.

Must never:

- import `playwright` outside `clients/browser.ts`
- let `domain/` read the clock, randomness, env, the network or the DB
- hit Facebook without a resolved, reachable proxy when one is configured (backfill requires one)
