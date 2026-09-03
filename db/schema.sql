CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  title TEXT,
  price_amount NUMERIC,
  price_currency TEXT,
  description TEXT,
  condition TEXT,
  category_id TEXT,
  location_lat NUMERIC,
  location_lng NUMERIC,
  location_city TEXT,
  primary_photo_url TEXT,
  stored_photo_urls JSONB,
  listed_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listings_title_idx ON listings USING gin (to_tsvector('english', coalesce(title, '')));
CREATE INDEX IF NOT EXISTS listings_listed_at_idx ON listings (listed_at);
-- Every product-scoped listings lookup (discount summary lateral, product
-- detail page, the base products-list JOIN) filters on this — without it,
-- getProductSummaries seq-scans all listings per product row. Confirmed live
-- 2026-08-23: adding this took the products-list query from ~2.9s to ~0.17s.
CREATE INDEX IF NOT EXISTS listings_product_id_idx ON listings (product_id);

-- Migration for tables created before stored_photo_urls existed (safe to re-run).
ALTER TABLE listings ADD COLUMN IF NOT EXISTS stored_photo_urls JSONB;

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  base_model TEXT NOT NULL,
  base_model_normalized TEXT NOT NULL,
  variant_tier TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS products_base_model_variant_idx
  ON products (base_model_normalized, COALESCE(variant_tier, ''));

CREATE TABLE IF NOT EXISTS variant_enums (
  base_model_normalized TEXT PRIMARY KEY,
  enum_values JSONB NOT NULL
);

ALTER TABLE listings ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id);

-- variant_tier is now extracted freely per-listing alongside base_model (no
-- predefined enum required upfront) - dedup on a normalized column so trivial
-- noise (case, whitespace, contraction apostrophes) doesn't fragment products,
-- while the raw variant_tier column keeps the original text for later review.
ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_tier_normalized TEXT;

-- Dashboard browsing/filtering only, not used to drive pipeline logic. Fixed,
-- bounded set (src/products.ts's PRODUCT_CATEGORIES), not a DB enum/CHECK -
-- same flexibility as variant_tier if the list needs adjusting later. Set
-- once at product creation by extract-products.ts's Gemini call (same pass
-- as base_model, no extra cost), never re-classified afterward. Existing
-- products stay NULL until a deferred batched backfill (see CONTEXT.md) -
-- backfill must batch multiple products per LLM call, not one-per-product.
ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT;

DROP INDEX IF EXISTS products_base_model_variant_idx;
CREATE UNIQUE INDEX IF NOT EXISTS products_base_model_variant_normalized_idx
  ON products (base_model_normalized, COALESCE(variant_tier_normalized, ''));

-- Append-only price history — one row per check, never updated in place, so
-- a price trend is just this table ordered by checked_at, not a single
-- "current price" column that would silently lose all prior values.
CREATE TABLE IF NOT EXISTS product_price_history (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  price_low NUMERIC,
  price_high NUMERIC,
  price_currency TEXT,
  raw_response TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_price_history_product_checked_idx
  ON product_price_history (product_id, checked_at);

-- Migration for tables created before raw_response existed (safe to re-run).
ALTER TABLE product_price_history ADD COLUMN IF NOT EXISTS raw_response TEXT;

-- 'listing_prices' (computed from our own collected listings, a free fill-in
-- while Gemini grounding is quota-limited) is NOT the same signal as
-- 'gemini_grounding' (independent external market data) — comparing a
-- listing's price against a range derived from this same marketplace's other
-- listings is a different, more circular comparison than an outside market
-- price would be. Tagging the source keeps the two from being silently
-- blended in later analysis.
ALTER TABLE product_price_history ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'gemini_grounding';

-- NULL = not condition-specific (e.g. Gemini's grounded range, which isn't
-- split by condition). A 'listing_prices' row is always tagged with the
-- exact condition label (e.g. "Used - Good") its range was computed from —
-- a blended across-conditions range hides real price-relevant variance
-- (a "Used - Fair" and a "New" of the same product don't belong in one range).
ALTER TABLE product_price_history ADD COLUMN IF NOT EXISTS condition TEXT;

-- Exa-specific: its grounding data reports "high"/"low" confidence per
-- extracted field (see src/new-price.ts's extractNewPriceConfidence). NULL
-- for gemini_grounding/listing_prices, which have no equivalent signal.
ALTER TABLE product_price_history ADD COLUMN IF NOT EXISTS confidence TEXT;

-- Exa-only (extractNewPriceMetadata) — free extra fields from the same
-- already-paid-for search, kept as dedicated queryable columns rather than
-- left buried in raw_response JSON, same reasoning as confidence above.
ALTER TABLE product_price_history ADD COLUMN IF NOT EXISTS release_year INTEGER;
ALTER TABLE product_price_history ADD COLUMN IF NOT EXISTS is_discontinued BOOLEAN;

-- Two-phase removal detection for check-listings: a listing that soft-walls
-- gets flagged (not deleted) on first hit — the same /login/ redirect FB
-- shows for a real removed listing is indistinguishable from a transient
-- session wall, so one hit alone isn't trusted. Only a listing that's STILL
-- soft-walled on a later, separate run (flagged_removed_at already set) gets
-- hard-deleted. If it turns out accessible again before that, the flag is
-- cleared instead — a recovered false positive, not silently ignored.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS flagged_removed_at TIMESTAMPTZ;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS listings_check_order_idx ON listings (last_checked_at, listed_at);

-- Product-level enrichment (description, value drivers, trained-knowledge price)
-- from an LLM's own parametric knowledge, no live search involved. product_id is
-- the primary key (upsert, not append-only) - unlike product_price_history (which
-- keeps every check as a trend point since live market prices move over time), a
-- model's trained knowledge doesn't change between runs unless the model itself
-- changes. The model column records which model produced the row, so a future
-- model upgrade has a clear signal for which rows are worth refreshing.
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

-- Groq's own judgment (same call as the rest of this row) of whether this
-- base_model names one real, specific, priceable product at all - not a price
-- opinion, a category-error catch (e.g. "Furniture"/"Lenovo Thinkpad" get
-- recognized and could get a confident-sounding price, but aren't one thing).
-- confidence accounts for training-cutoff gaps: a genuinely new/obscure
-- product should come back 'low' rather than a confident guess either way.
-- Nullable - rows written before this shipped have neither; left alone, not
-- backfilled (see applyEligibilityFromEnrichment in db.ts).
ALTER TABLE product_enrichment ADD COLUMN IF NOT EXISTS is_specific_product BOOLEAN;
ALTER TABLE product_enrichment ADD COLUMN IF NOT EXISTS confidence TEXT;

-- Sold is a terminal status Facebook reports directly (raw_json.is_sold), unlike
-- removed/deleted which is inferred from a soft-wall and needs two-phase
-- confirmation (see flagged_removed_at above) because a soft-wall is
-- indistinguishable from a transient session issue. Sold has no such ambiguity,
-- so it's a plain nullable timestamp set once, not a flag-then-confirm cycle.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ;

-- Per-listing price review for statistical outliers (see src/review-listing-prices.ts).
-- listings.price_amount is NEVER written to by this pipeline - it stays the raw
-- scraped source of truth always, same as product_enrichment does for products.
-- is_negotiable and price_low/price_high are independent signals, never coupled -
-- a listing can be a single fixed price AND negotiable, or a range AND not.
CREATE TABLE IF NOT EXISTS listing_price_review (
  listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  is_negotiable BOOLEAN NOT NULL,
  price_low NUMERIC,
  price_high NUMERIC,
  reasoning TEXT NOT NULL,
  model TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The description text a review was based on. getPriceReviewCandidates
-- re-flags a listing once its current description differs from this (a
-- seller editing in a price clarification is the case worth re-spending an
-- LLM call on) - listings.updated_at can't be used for this, refreshListingFields
-- bumps it on every confirmed-live re-scrape whether the text changed or not.
-- NULL on rows written by the keyword-scan path (upsertKeywordNegotiable),
-- which never looked at the description for pricing - so those stay eligible
-- for a real price review.
ALTER TABLE listing_price_review ADD COLUMN IF NOT EXISTS reviewed_description TEXT;

-- One-time backfill (idempotent via the IS NULL guard): seed the snapshot for
-- rows that already had a real LLM review, so the column's arrival doesn't
-- re-open the entire reviewed backlog at once. keyword-scan rows are left
-- NULL on purpose - they were never a real price review.
UPDATE listing_price_review r
SET reviewed_description = l.description
FROM listings l
WHERE l.id = r.listing_id
  AND r.model <> 'keyword-scan'
  AND r.reviewed_description IS NULL;

-- Normalizes the fixed 14-value category list (src/products.ts's
-- PRODUCT_CATEGORIES) out of products.category (plain TEXT, no referential
-- integrity - a typo or drift from the enum would silently sit in the
-- column forever) into its own table with an FK. Seeded once with the fixed
-- set; nothing else ever inserts into this table. The guard only touches
-- products.category if that column still exists, so this whole file stays
-- safe to replay after the one-time backfill+drop below has already run.
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

INSERT INTO categories (name) VALUES
  ('Phones & Tablets'), ('Computers & Laptops'), ('PC Components'),
  ('Cameras & Drones'), ('Audio'), ('Gaming'), ('TVs & Monitors'),
  ('Appliances'), ('Vehicles'), ('Real Estate'), ('Fashion'),
  ('Fitness & Outdoor'), ('Furniture & Home'), ('Other')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'category') THEN
    UPDATE products p SET category_id = c.id FROM categories c WHERE c.name = p.category AND p.category_id IS NULL;
    ALTER TABLE products DROP COLUMN category;
  END IF;
END $$;

-- Main-category grouping layer over the 14 categories above (dashboard
-- request 2026-08-28: too many flat categories to browse/chart at once).
-- Self-referencing rather than a separate main_categories table - these 14
-- rows are already the whole "categories" concept, a main category is just
-- one more row of the same shape with children pointing at it. Deliberately
-- does NOT touch products.category_id or re-run any LLM classification:
-- every existing product already has a valid sub-category, and main is a
-- pure presentation-layer join over that - see queries.ts.
ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES categories(id);

INSERT INTO categories (name) VALUES
  ('Phones & Computing'), ('Home Electronics & Gaming'), ('Home & Furniture'),
  ('Fashion & Lifestyle')
ON CONFLICT (name) DO NOTHING;
-- Vehicles, Real Estate, and Other are each their own main category too
-- (single-child group - see dashboard's CategorySoldChart design notes) but
-- need no new row: a sub-category with no parent_id is its own main.

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE name = 'Phones & Computing')
  WHERE name IN ('Phones & Tablets', 'Computers & Laptops', 'PC Components') AND parent_id IS NULL;
UPDATE categories SET parent_id = (SELECT id FROM categories WHERE name = 'Home Electronics & Gaming')
  WHERE name IN ('TVs & Monitors', 'Audio', 'Gaming', 'Cameras & Drones') AND parent_id IS NULL;
UPDATE categories SET parent_id = (SELECT id FROM categories WHERE name = 'Home & Furniture')
  WHERE name IN ('Appliances', 'Furniture & Home') AND parent_id IS NULL;
UPDATE categories SET parent_id = (SELECT id FROM categories WHERE name = 'Fashion & Lifestyle')
  WHERE name IN ('Fashion', 'Fitness & Outdoor') AND parent_id IS NULL;

-- Third tree level: finer sub-categories under each of the 14 categories
-- above (dashboard request 2026-08-28 - "can we properly categorize these
-- products" led to the existing 14 being judged too coarse to browse by).
-- products.sub_category_id is a NEW, separate column from category_id, not
-- a repoint of it - category_id keeps meaning exactly what every existing
-- dashboard query/filter/icon already assumes it means (one of the 14), so
-- none of that breaks. sub_category_id is additive: NULL until the
-- backfill-sub-categories worker (mirrors backfill-categories) sets it.
-- 'Other' is deliberately NOT split further (it's the catch-all - see
-- products.ts's SUB_CATEGORIES comment) and gets no new child row; it's
-- reused as-is as one of the fixed leaf options every product can land on.
ALTER TABLE products ADD COLUMN IF NOT EXISTS sub_category_id INTEGER REFERENCES categories(id);

INSERT INTO categories (name, parent_id) VALUES
  ('Smartphones', (SELECT id FROM categories WHERE name = 'Phones & Tablets')),
  ('Tablets', (SELECT id FROM categories WHERE name = 'Phones & Tablets')),
  ('Phone & Tablet Accessories', (SELECT id FROM categories WHERE name = 'Phones & Tablets')),
  ('Laptops', (SELECT id FROM categories WHERE name = 'Computers & Laptops')),
  ('Desktops', (SELECT id FROM categories WHERE name = 'Computers & Laptops')),
  ('Graphics Cards', (SELECT id FROM categories WHERE name = 'PC Components')),
  ('Processors & Motherboards', (SELECT id FROM categories WHERE name = 'PC Components')),
  ('Storage & Memory', (SELECT id FROM categories WHERE name = 'PC Components')),
  ('Power Supplies & Cases', (SELECT id FROM categories WHERE name = 'PC Components')),
  ('TVs', (SELECT id FROM categories WHERE name = 'TVs & Monitors')),
  ('Monitors', (SELECT id FROM categories WHERE name = 'TVs & Monitors')),
  ('Headphones & Earphones', (SELECT id FROM categories WHERE name = 'Audio')),
  ('Speakers', (SELECT id FROM categories WHERE name = 'Audio')),
  ('Consoles', (SELECT id FROM categories WHERE name = 'Gaming')),
  ('Games & Accessories', (SELECT id FROM categories WHERE name = 'Gaming')),
  ('Cameras', (SELECT id FROM categories WHERE name = 'Cameras & Drones')),
  ('Drones', (SELECT id FROM categories WHERE name = 'Cameras & Drones')),
  ('Camera Accessories', (SELECT id FROM categories WHERE name = 'Cameras & Drones')),
  ('Small Appliances', (SELECT id FROM categories WHERE name = 'Appliances')),
  ('Large Appliances', (SELECT id FROM categories WHERE name = 'Appliances')),
  ('Furniture', (SELECT id FROM categories WHERE name = 'Furniture & Home')),
  ('Home Decor & Household Items', (SELECT id FROM categories WHERE name = 'Furniture & Home')),
  ('Cars', (SELECT id FROM categories WHERE name = 'Vehicles')),
  ('Motorcycles', (SELECT id FROM categories WHERE name = 'Vehicles')),
  ('Bicycles', (SELECT id FROM categories WHERE name = 'Vehicles')),
  ('Vehicle Parts & Accessories', (SELECT id FROM categories WHERE name = 'Vehicles')),
  ('House & Lot', (SELECT id FROM categories WHERE name = 'Real Estate')),
  ('Condo/Apartment', (SELECT id FROM categories WHERE name = 'Real Estate')),
  ('Land', (SELECT id FROM categories WHERE name = 'Real Estate')),
  ('Rentals', (SELECT id FROM categories WHERE name = 'Real Estate')),
  ('Women''s Clothing', (SELECT id FROM categories WHERE name = 'Fashion')),
  ('Men''s Clothing', (SELECT id FROM categories WHERE name = 'Fashion')),
  ('Bags', (SELECT id FROM categories WHERE name = 'Fashion')),
  ('Shoes', (SELECT id FROM categories WHERE name = 'Fashion')),
  ('Exercise Equipment', (SELECT id FROM categories WHERE name = 'Fitness & Outdoor')),
  ('Outdoor & Camping Gear', (SELECT id FROM categories WHERE name = 'Fitness & Outdoor'))
ON CONFLICT (name) DO NOTHING;

-- Some base_model values aren't real, priceable products (real estate, bare
-- category placeholders like "GPU"/"Item", parts/accessories with no single
-- fixed retail price, services). "New-retail price" is a meaningless concept
-- for these — both new-price-lookup.ts (Exa, costs real money per call) and
-- price-lookup.ts (Gemini grounding, burns quota) skip anything flagged here.
-- Two writers: the manually curated list (src/flag-price-ineligible.ts) for
-- known junk, and product_enrichment.is_specific_product/confidence (same
-- worker, see applyEligibilityFromEnrichment in db.ts) for everything else.
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_lookup_excluded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_lookup_excluded_reason TEXT;

-- Set when product_enrichment.confidence comes back 'low' - Groq itself isn't
-- sure whether this base_model is a real specific product (could be outside
-- its training knowledge either way). NULL = no open question. Candidate
-- queries (getPriceLookupCandidates, getNewPriceCandidates) skip anything
-- flagged here until a human resolves it via the (not yet built) admin
-- review page - never auto-resolves.
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_lookup_review_status TEXT;

-- Set by markProductReviewed when a human clears needs_review as "fine
-- as-is, still priceable" (NOT excludeProductFromReview's "not a real
-- product" path - that already sticks via price_lookup_excluded). Without
-- this, applyEligibilityFromEnrichment re-flags the product back to
-- needs_review on its very next lap: it reruns unconditionally every
-- enrich-products loop, matching on product_enrichment.confidence = 'low'
-- alone, which never changes since a product is only ever enriched once -
-- confirmed live 2026-09-03, already-reviewed products with retail/secondhand
-- prices resurfacing in the needs-review queue. NULL = never dismissed.
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_lookup_review_dismissed_at TIMESTAMPTZ;

-- Dashboard-only bookmark list (no scraper/src writes or reads this). One
-- shared saved-list, not per-user — the dashboard has a single shared
-- password, no account system. ON DELETE CASCADE deliberately, unlike
-- listing_price_review's plain REFERENCES above: check-listings.ts's
-- deleteListing() does a bare DELETE FROM listings with no child-row
-- cleanup, so a saved listing that later gets confirmed-removed must not
-- FK-block that delete.
CREATE TABLE IF NOT EXISTS saved_listings (
  listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Written once, at extraction time, when a listing first crosses the
-- high-discount bar against its product's clean median (see
-- detectAndRecordDiscountNotifications in domains/marketplace/storage/
-- listings.ts). Deliberately NOT re-evaluated later if sibling listings
-- shift the median afterward - same "set once" tradeoff this codebase
-- already makes for base_model/category. UNIQUE on listing_id both
-- enforces "at most one notification per listing ever" and gives the
-- insert its idempotency for free (ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS discount_notifications (
  id SERIAL PRIMARY KEY,
  listing_id TEXT NOT NULL UNIQUE REFERENCES listings(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  discount_percent INTEGER NOT NULL,
  reference_price NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS discount_notifications_unread_idx
  ON discount_notifications (created_at) WHERE read_at IS NULL;

-- Operator-tunable worker cadence/batch/pacing/retry knobs and
-- discount-policy thresholds, previously hardcoded source constants (see
-- src/platform/settings.ts's SETTING_DEFAULTS for the full key list and
-- fallback values). Workers re-query this every lap - same "no restart
-- needed" pattern as re-querying candidate rows every lap. INTEGER, not
-- NUMERIC: every value here is a whole number (ms/counts/percent/pesos),
-- and NUMERIC comes back from pg as a string, not a number - INTEGER avoids
-- that cast entirely.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('collect.max_items_default', 100),
  ('collect.soft_wall_timeout_ms', 5000),
  ('collect.pacing_min_ms', 4000),
  ('collect.pacing_max_ms', 10000),
  ('check_listings.loop_delay_ms', 60000),
  ('check_listings.limit_default', 100),
  ('check_listings.soft_wall_timeout_ms', 5000),
  ('check_listings.pacing_min_ms', 2000),
  ('check_listings.pacing_max_ms', 4000),
  ('extract_products.max_attempts', 5),
  ('extract_products.retry_base_delay_ms', 30000),
  ('extract_products.loop_delay_ms', 300000),
  ('extract_products.batch_size', 100),
  ('extract_products.inter_batch_delay_ms', 5000),
  ('enrich_products.batch_size', 20),
  ('enrich_products.loop_delay_ms', 300000),
  ('enrich_products.max_attempts', 3),
  ('enrich_products.retry_delay_ms', 3000),
  ('price_lookup.lap_limit_default', 20),
  ('price_lookup.loop_delay_ms', 300000),
  ('price_lookup.pacing_delay_ms', 1000),
  ('enrich_listing_prices.batch_size', 35),
  ('enrich_listing_prices.loop_delay_ms', 300000),
  ('verify_discount.lap_limit_default', 3),
  ('verify_discount.fetch_batch_size', 50),
  ('verify_discount.loop_delay_ms', 30000),
  ('verify_discount.pacing_delay_ms', 1000),
  ('discount_policy.high_discount_threshold_percent', 30),
  ('discount_policy.min_profit_pesos', 1000),
  ('discount_policy.min_price_pesos', 500),
  ('discount_policy.gemini_daily_grounding_cap', 1000)
ON CONFLICT (key) DO NOTHING;

-- Operator-editable search-query list for collect.ts's --cycle loop
-- (previously the hardcoded MOTIVATED_SELLER_KEYWORDS array). Loaded fresh
-- every lap, same no-restart pattern as the settings table above. Empty
-- table (not just a missing row) falls back to DEFAULT_COLLECT_KEYWORDS in
-- src/platform/collect-keywords.ts - collect must never run a lap with zero
-- search queries.
CREATE TABLE IF NOT EXISTS collect_keywords (
  keyword TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO collect_keywords (keyword) VALUES
  ('rush sale'),
  ('moving out'),
  ('preloved'),
  ('slightly used'),
  ('barely used'),
  ('decluttering'),
  ('upgrade'),
  ('for disposal')
ON CONFLICT (keyword) DO NOTHING;

-- listing_price_review's FK to listings was missing ON DELETE CASCADE -
-- check-listings.ts's deleteListing() does a bare DELETE FROM listings with
-- no child-row cleanup (same gap saved_listings/discount_notifications were
-- already built to avoid). Hit live 2026-08-30: a confirmed-removed
-- listing with a price-review row threw a real FK violation and got stuck
-- permanently undeletable (photos already gone from R2, DB row stranded).
-- The CREATE TABLE above is edited to match for any future fresh DB; this
-- retroactively fixes the constraint on an existing one.
ALTER TABLE listing_price_review DROP CONSTRAINT IF EXISTS listing_price_review_listing_id_fkey;
ALTER TABLE listing_price_review ADD CONSTRAINT listing_price_review_listing_id_fkey
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE;

-- AI verification gate (see docs/superpowers/specs/2026-08-30-discount-notification-
-- verification-design.md) - a discount_notifications row is invisible to the
-- dashboard (getDiscountNotifications/getUnreadDiscountNotificationCount both
-- filter on this) until verified_at is set by verify-discount-notifications.ts.
-- last_verification_attempt_at backs off retries on transient failures (network/
-- API errors) so a stuck candidate doesn't re-burn a paid Tavily/Exa call every
-- worker loop tick. A definitive rejection (any check says no) just DELETEs the
-- row instead of using a status column - each listing only ever gets one
-- candidate row ever (see the original UNIQUE(listing_id)), so there's nothing
-- to leave a tombstone for.
ALTER TABLE discount_notifications ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE discount_notifications ADD COLUMN IF NOT EXISTS last_verification_attempt_at TIMESTAMPTZ;
ALTER TABLE discount_notifications ADD COLUMN IF NOT EXISTS verification_source TEXT;
ALTER TABLE discount_notifications ADD COLUMN IF NOT EXISTS verification_reasoning TEXT;

CREATE INDEX IF NOT EXISTS discount_notifications_pending_idx
  ON discount_notifications (last_verification_attempt_at)
  WHERE verified_at IS NULL;

-- server_service is the role prod workers (server/, and the root tsx workers
-- deployed to the scraper host) connect as - it is NOT the owner role that
-- runs this script. Every table below was at some point created (or an
-- existing table's grant left incomplete) without a matching GRANT, which
-- silently 42501'd the next worker run that touched it (hit live 2026-08-31
-- twice in a row: `products` via enrich-products, then `listings` INSERT via
-- the collector - listings had SELECT/UPDATE/DELETE but nobody had ever
-- granted INSERT). The default-privileges rule makes any future CREATE TABLE
-- by the owner auto-grant to server_service so this can't recur.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  listings, products, product_enrichment, product_price_history,
  discount_notifications, saved_listings, variant_enums
TO server_service;
GRANT SELECT, INSERT, UPDATE ON listing_price_review TO server_service;
GRANT SELECT ON categories TO server_service;

-- A table GRANT (above) does NOT cover a SERIAL column's backing sequence -
-- INSERT into a table with SERIAL id still needs its own USAGE grant on the
-- id_seq for nextval() to work (hit live 2026-08-31, extract-products:
-- "permission denied for sequence products_id_seq", right after the table
-- grant above alone looked sufficient but wasn't).
GRANT USAGE, SELECT ON
  categories_id_seq, discount_notifications_id_seq,
  product_price_history_id_seq, products_id_seq
TO server_service;

ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO server_service;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO server_service;
