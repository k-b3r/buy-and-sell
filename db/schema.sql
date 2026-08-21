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
