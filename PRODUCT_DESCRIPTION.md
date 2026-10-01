# Facebook Marketplace Buy-and-Sell Intelligence

A free, locally-run tool for collecting and analyzing publicly visible Facebook Marketplace listing data to identify potentially profitable buy-and-sell opportunities in the Philippines.

> **Status note:** This document is the long-term product vision — goal, roadmap, eventual analytics/deal-scoring design. It predates implementation and some of its original assumptions (notably: using the user's own logged-in Facebook account) were deliberately overridden once real engineering constraints showed up. `CONTEXT.md` is the living decision log for what's actually been built and why — where the two disagree, `CONTEXT.md` wins. This doc has been updated to match, but treat `CONTEXT.md` as the source of truth for current behavior.

## 🎯 Goal

Build a personal market intelligence system that helps answer:

> **"What products are currently undervalued on Facebook Marketplace and could potentially be resold for a profit?"**

The system collects Marketplace listing information via a locally controlled, **logged-out** browser session — not the user's own authenticated Facebook account (see Collection Approach below) — stores data locally, analyzes market prices, and identifies potentially attractive deals.

The project is intended for **personal use** with a **₱0 software/tooling budget**.

---

## 🔐 Collection Approach (no-login by design)

**This overrides the original assumption of using the user's authenticated account.** Real-world testing showed:

- Meta's Terms of Service prohibit automated data collection outright, logged in or not — using the user's real account risked an actual account ban (checkpoints, restrictions, permanent loss of access).
- A **no-login, logged-out** collector removes that risk entirely: no session, no cookies, nothing tied to a real account for Facebook to act against. The only residual risk is IP-level rate-limiting/soft-walls, which is far lower stakes and just means a slower run, not a lost account.
- Facebook still requires a real browser (Playwright/Chromium) even logged out — plain HTTP requests are rejected outright at the edge (missing browser fingerprint signals). No shortcut around running an actual browser.
- Logged-out Marketplace pages embed listing data as JSON directly in the page (server-rendered), which the collector reads — no scraping of rendered HTML text, no DOM-scraping fragility.
- Consequence: private Groups and Pages (login-gated) are **not reachable** this way. Deferred to a later phase with a separate access strategy.

See `CONTEXT.md` → "Collector" for full technical detail (bot-detection findings, wall-handling behavior, pacing rationale).

---

## 🏗️ Architecture

```text
┌──────────────────────────┐
│   Facebook Marketplace   │
│                          │
│  Logged-out, no account  │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│      Local Collector     │
│                          │
│ Playwright + TypeScript  │
│ Headed browser, human-   │
│ paced, manually triggered│
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│       Data Storage       │
│                          │
│  JSONL (v0) → PostgreSQL │
│      (later phase)       │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│     Data Processing      │
│                          │
│ Normalization            │
│ Deduplication             │
│ Price history             │
│ Product identification    │
│      (all deferred)       │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│        Analytics         │
│                          │
│ Market prices             │
│ Price distribution        │
│ Location analysis         │
│ Product trends             │
│      (deferred)            │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│      Deal Detection      │
│                          │
│ Estimated resale price    │
│ Expected profit            │
│ ROI                         │
│ BUY SCORE                    │
│      (deferred)               │
└──────────────────────────┘
```

---

# 🚀 Core Features

## 1. Marketplace Listing Collection

The collector uses a locally controlled, **logged-out headed browser** (Playwright/Chromium) to read Marketplace search results Facebook serves anonymously — not an authenticated session.

Two-stage collection per run:

- **Stage 1 (grid):** the search-results page, read as-loaded — title, price, thumbnail, location, listing ID/URL. Near-zero navigations, wall rarely triggers here.
- **Stage 2 (detail):** each listing opened individually for full detail — description, condition (when the seller filled it in), images, seller info. This is where pacing/wall-handling matters most.

No fixed schema is forced — the collector captures **whatever fields Facebook's page actually includes** for a given listing (condition and multi-photo galleries are seller-dependent and often absent even at detail level). A `raw_json`-style catch-all is the intended long-term approach once a database exists, so newly-discovered fields don't require a schema migration every time.

Data actually available per listing includes (not all fields guaranteed present):

- Listing ID, URL, title, price (nested object with currency, not a flat number)
- Location (city name at grid level via reverse-geocode; raw lat/long only at detail level — inconsistent between stages)
- Condition (often missing)
- Description (`redacted_description.text`)
- Primary photo URL (grid) / photo gallery (detail, when present)
- Delivery type (local pickup / shipping)
- Listed timestamp

**Image URLs are signed and expire** (days, not permanent) — Facebook's CDN issues a fresh signed URL on every real page load. For long-term storage, the actual image bytes need to be downloaded while the URL is valid, not just the URL string.

The collector only processes information a logged-out, anonymous browser session can see — it does not attempt to bypass CAPTCHA or hard blocks (see Wall Handling below).

### Result volume: the 24-item ceiling, and how it's crossed

A single Marketplace search serves a **fixed initial batch of 24 listings** embedded directly in the page — regardless of query. Scrolling triggers nothing in a logged-out session (Facebook's client-side pagination JS doesn't appear to activate without an authenticated session).

Going beyond 24 requires calling Facebook's internal pagination API directly (same GraphQL endpoint the site itself uses for infinite-scroll) — confirmed reachable and functional **without logging in**, using a per-page-load security token (`lsd`) and continuation cursor Facebook already embeds in the page. The collector does this from inside the loaded page (same-origin), not as an external API client. Paced identically to per-listing navigation, capped, and deduplicated. See `CONTEXT.md` → "Pagination beyond initial batch" for the full mechanism.

### Location targeting

Facebook has **no working free-text or geolocation-based location filter** for a logged-out session — confirmed via multiple failed approaches (URL query param, browser geolocation permission, locale/timezone). The only mechanism that works is a recognized **location slug** in the URL path (`facebook.com/marketplace/<slug>/search/`). `manila` is the confirmed-working slug and surfaces real Dasmariñas/Cavite-area results; there is no dedicated `dasmarinas` slug. v0 hardcodes `manila`.

---

## 2. Listing Deduplication

Marketplace searches may return the same listing multiple times (especially across pagination pages).

The Facebook Marketplace listing ID is the primary identifier and is deduplicated in-memory during a collection run.

Example:

```text
https://www.facebook.com/marketplace/item/10000000000000005/
```

Listing ID:

```text
10000000000000005
```

Persistent dedup (repeated observations across separate runs updating the same DB record rather than creating duplicates) is a database-phase feature — not yet built, since v0 has no database.

---

## 3. Historical Price Tracking

**Deferred — not yet built.** A major long-term purpose of the project is historical pricing data:

```text
Aug 10 → ₱18,000
Aug 12 → ₱17,000
Aug 14 → ₱15,000
Aug 17 → ₱13,500
```

This would allow identifying price reductions, seller negotiation signals, listing age, price stability, motivated sellers, and market pricing changes — but requires a database and repeat observations over time, neither of which exist yet. v0 is single-run, JSONL-only collection.

---

# 📊 Market Analysis

**Deferred — not yet built.** The system should eventually calculate statistics for individual products and categories.

### Product-level analysis (target shape)

```text
Product: RTX 3060 12GB

Listings analyzed: 127

Average price: ₱16,850
Median price: ₱16,000
Lowest price: ₱12,500
Highest price: ₱22,000

25th percentile: ₱14,000
75th percentile: ₱18,500
```

### Category-level analysis (target shape)

```text
Category: GPUs

Average margin: ₱3,800
Average ROI: 21%
Average listing age: 14 days
```

---

# 💰 Buy-and-Sell Analysis

**Deferred — not yet built.** The main objective is not simply to find cheap products, but whether purchasing one creates a realistic resale opportunity.

The basic calculation:

```text
Expected Profit =
Expected Resale Price
- Purchase Price
- Transportation
- Repair Cost
- Platform Fees
- Other Expenses
```

ROI:

```text
ROI =
Expected Profit / Purchase Price
```

Example:

```text
Purchase price:       ₱14,000
Expected resale:      ₱19,000
Transportation:          ₱300
Repair/refurbishment:    ₱500
Other costs:              ₱200

Expected profit:       ₱4,000
ROI:                    28.6%
```

---

# 🔥 Deal Detection

**Deferred — not yet built.** Listings should eventually receive a calculated deal score.

Example:

```text
---------------------------------
🔥 POTENTIAL DEAL
---------------------------------

Product:
RTX 3060 12GB

Marketplace Price:
₱14,000

Estimated Market Price:
₱18,000

Estimated Resale:
₱17,500

Estimated Expenses:
₱800

Expected Profit:
₱2,700

Expected ROI:
19.3%

BUY SCORE:
87 / 100

Confidence:
High
---------------------------------
```

The score can consider:

- Difference from median market price
- Expected resale value
- Expected ROI
- Listing age
- Price reductions
- Product demand
- Condition
- Location
- Historical resale performance
- Number of competing listings

---

# 📍 Philippine Market Analysis

The initial market focus is the Philippines, currently centered on Metro Manila / Cavite via the `manila` location slug (see Location Targeting above — this is a Facebook platform constraint, not a product choice to exclude other regions).

Location should be retained whenever available.

```text
Metro Manila
Cavite
Laguna
Batangas
Rizal
Pampanga
Cebu
Davao
```

Geographic price-difference analysis (target shape, deferred):

```text
RTX 3060

Metro Manila median: ₱17,000
Cavite median:        ₱15,500
Laguna median:        ₱16,000
```

---

# 🧠 Product Identification

**Deferred — explicitly decided as premature until real scraped data volume exists to design against.**

Marketplace titles are inconsistent, e.g.:

```text
RTX 3060 12gb Asus
Asus RTX3060 OC 12G
3060 12 GB GPU
ASUS 3060 dual fan
RTX3060 12G
```

These should eventually be recognized as the same underlying product, normalizing Brand / Model / Variant / Storage / Memory / Condition / Generation into a canonical product:

```text
Raw title:
"ASUS RTX3060 Dual OC 12GB"

Canonical product:
ASUS RTX 3060 12GB
```

---

# 🗄️ Proposed Database

**Not yet built — v0 stores JSONL, no database.** Schema below is the current best guess, informed by real captured listing data (not just speculative field names), and will likely gain a `raw_json` catch-all column per table once implemented, since Facebook's actual payload has far more inconsistent/undocumented structure than originally assumed (nested price objects, location shape differing between grid and detail views, condition/photos frequently absent).

## `listings`

```text
id
marketplace_listing_id
url
title
description
price
currency
category
condition
location
seller_id
first_seen_at
last_seen_at
status
raw_json
created_at
updated_at
```

## `listing_price_history`

```text
id
listing_id
price
observed_at
```

## `products`

```text
id
brand
model
variant
category
canonical_name
```

## `listing_products`

```text
listing_id
product_id
confidence
```

## `market_statistics`

```text
product_id
sample_size
average_price
median_price
min_price
max_price
percentile_25
percentile_75
calculated_at
```

---

# 🛠️ Technology Stack

## Backend

- Node.js
- TypeScript
- pnpm (package manager)

## Browser Automation

- Playwright (headed Chromium, logged-out)

## Testing

- Vitest

## Database

- PostgreSQL (not yet built — v0 is JSONL only)

## Data Processing

- TypeScript initially
- Python optionally for advanced analysis

## API

Optional, future:

- Node.js
- Fastify or Express

## Dashboard

Optional, future:

- Next.js
- React

## AI

Optional later:

- LLM API
- Local LLM

The core system should remain functional without paid AI services.

---

# 💸 Cost Requirement

Target operating cost:

**₱0**

No paid:

- Scraping APIs
- Proxy services
- Marketplace APIs
- Cloud servers
- Paid databases
- Paid analytics platforms

The system runs entirely on the developer's own computer / network.

---

# 🧪 Development Phases

## Phase 1 — Proof of Concept ✅ Done

Actual implementation (superseded the original "authenticate manually" plan — see Collection Approach above):

- Launch headed, logged-out browser
- Open Marketplace search (no auth)
- Read currently loaded listings (grid stage)
- Extract listing IDs, URLs, whatever fields are present
- Save results to JSONL

Output:

```text
data/listings.jsonl
```

## Phase 2 — Structured Extraction ✅ Done

Extract per-listing detail (stage 2): title, price, location, condition (when present), description, images, listing URL, listing ID. CLI-driven, one-item-at-a-time with manual y/n/stop review before saving — nothing writes to output unapproved. Human-readable, timestamped logs for verification.

**Beyond original scope:** pagination past the initial 24-item batch, implemented and live-verified (see Result Volume above).

## Phase 3 — PostgreSQL — Not started

Move from JSONL to PostgreSQL:

- Listing insertion, deduplication, updates
- Historical observations, price history

## Phase 4 — Market Analytics — Not started

- Average/median price, percentiles, price distributions
- Product comparisons, category analysis, geographic analysis

## Phase 5 — Deal Detection — Not started

- Expected resale price, profit calculation, ROI
- Deal score, confidence score

## Phase 6 — Automation — Not started, and reconsider before building

```text
Search → Collect → Normalize → Deduplicate → Analyze → Detect deals
```

**Note:** the original vision of periodic/automated collection is in tension with the no-login safety model — manual, user-triggered runs with human pacing is what keeps IP-level rate-limiting risk low. Any future automation (e.g. a scheduled job) should be weighed against that tradeoff explicitly, not assumed.

---

# 🎯 Initial Target Categories

**First category actually chosen: Audio equipment** (mics, headphones, mixers) — not the original candidate list below, which remains the aspirational list for categories to expand into later.

Original candidate list:

1. Smartphones
2. GPUs
3. Laptops
4. Gaming consoles
5. Cameras
6. Monitors
7. Computer components
8. Appliances
9. Power tools
10. Bicycles

The first category should be selected based on: high demand, reasonable resale value, easy transportation, low repair risk, sufficient Marketplace volume, observable price differences.

---

# 🔮 Future Features

Potential future improvements:

- Automatic product matching
- Price prediction
- Seller behavior analysis
- Listing-age prediction
- Price-drop alerts
- Telegram notifications
- Deal dashboard
- Category opportunity ranking
- Geographic arbitrage detection
- Resale probability prediction
- Estimated time-to-sale
- Profit forecasting
- Historical market charts
- Personal transaction tracking

---

# 🏆 Ultimate Goal

The end product should become a personal **buy-and-sell intelligence engine**.

Instead of manually browsing hundreds of Marketplace listings, the system should eventually answer:

> **"What should I buy today if I want to maximize my probability of making a profit when reselling in the Philippines?"**

The system should prioritize **actionable opportunities**, not simply collect data.

```text
Marketplace Data
       ↓
Market Intelligence
       ↓
Price Analysis
       ↓
Profit Estimation
       ↓
Deal Detection
       ↓
BUY
```

## ⚠️ Important Constraint

**Superseded/clarified by real implementation** — see Collection Approach above for the full reasoning:

The project uses a **logged-out, no-account** approach specifically to minimize risk under Facebook's applicable terms — automated collection is against Meta's ToS regardless of login state, so the mitigation is architectural (no account to lose, only IP-level rate-limiting as residual risk), not an attempt to "stay within" rules that flatly prohibit automation either way.

The collector does not attempt to bypass CAPTCHA or hard-block challenges — on detecting anything other than a known-recoverable soft wall, it fails closed, stops the run, and logs the failure rather than guessing or retrying. Facebook's own internal pagination API is used the same way the site's own client uses it (same-origin, from within a real loaded page, using tokens Facebook itself issues to that page) — not an external/unofficial API integration.
