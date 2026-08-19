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
  listed_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listings_title_idx ON listings USING gin (to_tsvector('english', coalesce(title, '')));
CREATE INDEX IF NOT EXISTS listings_listed_at_idx ON listings (listed_at);
