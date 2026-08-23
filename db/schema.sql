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
  listing_id TEXT PRIMARY KEY REFERENCES listings(id),
  is_negotiable BOOLEAN NOT NULL,
  price_low NUMERIC,
  price_high NUMERIC,
  reasoning TEXT NOT NULL,
  model TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Some base_model values aren't real, priceable products (real estate, bare
-- category placeholders like "GPU"/"Item", parts/accessories with no single
-- fixed retail price, services). "New-retail price" is a meaningless concept
-- for these — both new-price-lookup.ts (Exa, costs real money per call) and
-- price-lookup.ts (Gemini grounding, burns quota) skip anything flagged here.
-- Manually curated (src/flag-price-ineligible.ts), not auto-classified.
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_lookup_excluded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_lookup_excluded_reason TEXT;
