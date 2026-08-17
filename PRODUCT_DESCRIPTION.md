# Facebook Marketplace Buy-and-Sell Intelligence

A free, locally-run tool for collecting and analyzing publicly visible Facebook Marketplace listing data to identify potentially profitable buy-and-sell opportunities in the Philippines.

## 🎯 Goal

Build a personal market intelligence system that helps answer:

> **"What products are currently undervalued on Facebook Marketplace and could potentially be resold for a profit?"**

The system will collect Marketplace listing information from searches performed through the user's own Facebook account and browser, store historical data locally, analyze market prices, and identify potentially attractive deals.

The project is intended for **personal use** with a **₱0 software/tooling budget**.

---

## 🏗️ Architecture

```text
┌──────────────────────────┐
│   Facebook Marketplace   │
│                          │
│  User's normal browser   │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│      Local Collector     │
│                          │
│ Playwright + TypeScript  │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│       Data Storage       │
│                          │
│ PostgreSQL / JSON / CSV  │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│     Data Processing      │
│                          │
│ Normalization            │
│ Deduplication            │
│ Price history            │
│ Product identification   │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│        Analytics         │
│                          │
│ Market prices            │
│ Price distribution       │
│ Location analysis        │
│ Product trends           │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│      Deal Detection      │
│                          │
│ Estimated resale price   │
│ Expected profit          │
│ ROI                      │
│ BUY SCORE                │
└──────────────────────────┘
```

---

# 🚀 Core Features

## 1. Marketplace Listing Collection

The application will use a locally controlled browser session to inspect Marketplace search results that the user can normally access.

Initial data to collect:

* Listing ID
* Listing URL
* Title
* Price
* Currency
* Location
* Condition
* Description
* Image URLs
* First-seen timestamp
* Last-seen timestamp

The collector should only process information available to the user's authenticated browser session and should not attempt to bypass Facebook's authentication, CAPTCHA, rate limits, or other access controls.

---

## 2. Listing Deduplication

Marketplace searches may return the same listing multiple times.

The Facebook Marketplace listing ID will be used as the primary identifier.

Example:

```text
https://www.facebook.com/marketplace/item/10000000000000005/
```

Listing ID:

```text
10000000000000005
```

Repeated observations of the same listing should update the existing record rather than create duplicates.

---

## 3. Historical Price Tracking

A major purpose of the project is to build historical pricing data.

Example:

```text
Aug 10 → ₱18,000
Aug 12 → ₱17,000
Aug 14 → ₱15,000
Aug 17 → ₱13,500
```

This allows the system to identify:

* Price reductions
* Seller negotiation signals
* Listing age
* Price stability
* Potentially motivated sellers
* Changes in market pricing

---

# 📊 Market Analysis

The system should calculate statistics for individual products and categories.

### Product-level analysis

Example:

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

### Category-level analysis

Example:

```text
Category: GPUs

Average margin: ₱3,800
Average ROI: 21%
Average listing age: 14 days
```

The system should eventually rank categories based on potential profitability.

---

# 💰 Buy-and-Sell Analysis

The main objective is not simply to find cheap products.

It is to determine whether purchasing a product creates a realistic opportunity for resale.

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

Listings can receive a calculated deal score.

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

* Difference from median market price
* Expected resale value
* Expected ROI
* Listing age
* Price reductions
* Product demand
* Condition
* Location
* Historical resale performance
* Number of competing listings

---

# 📍 Philippine Market Analysis

The initial market focus is the Philippines.

Location should be retained whenever available.

Example:

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

This enables geographic analysis such as:

```text
RTX 3060

Metro Manila median: ₱17,000
Cavite median:        ₱15,500
Laguna median:        ₱16,000
```

Potential opportunities can then be identified based on geographic price differences.

---

# 🧠 Product Identification

Marketplace titles are inconsistent.

For example:

```text
RTX 3060 12gb Asus
Asus RTX3060 OC 12G
3060 12 GB GPU
ASUS 3060 dual fan
RTX3060 12G
```

These should eventually be recognized as the same underlying product.

The system should normalize:

```text
Brand
Model
Variant
Storage
Memory
Condition
Generation
```

into a canonical product.

Example:

```text
Raw title:
"ASUS RTX3060 Dual OC 12GB"

Canonical product:
ASUS RTX 3060 12GB
```

---

# 🗄️ Proposed Database

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

* Node.js
* TypeScript

## Browser Automation

* Playwright

## Database

* PostgreSQL

## Data Processing

* TypeScript initially
* Python optionally for advanced analysis

## API

Optional:

* Node.js
* Fastify or Express

## Dashboard

Optional:

* Next.js
* React

## AI

Optional later:

* LLM API
* Local LLM

The core system should remain functional without paid AI services.

---

# 💸 Cost Requirement

Target operating cost:

**₱0**

No paid:

* Scraping APIs
* Proxy services
* Marketplace APIs
* Cloud servers
* Paid databases
* Paid analytics platforms

The initial system should run entirely on the developer's own computer.

---

# 🧪 Development Phases

## Phase 1 — Proof of Concept

Goal: determine whether Marketplace data can be reliably extracted from the user's browser.

Tasks:

* Launch browser
* Authenticate manually
* Open Marketplace
* Read currently loaded listings
* Extract listing IDs
* Extract URLs
* Save results to JSON

Output:

```text
listings.json
```

---

## Phase 2 — Structured Extraction

Extract:

* Title
* Price
* Location
* Condition
* Description
* Images
* Listing URL
* Listing ID

Output:

```text
listings.csv
```

---

## Phase 3 — PostgreSQL

Move from files to PostgreSQL.

Implement:

* Listing insertion
* Deduplication
* Updates
* Historical observations
* Price history

---

## Phase 4 — Market Analytics

Implement:

* Average price
* Median price
* Percentiles
* Price distributions
* Product comparisons
* Category analysis
* Geographic analysis

---

## Phase 5 — Deal Detection

Implement:

* Expected resale price
* Profit calculation
* ROI
* Deal score
* Confidence score

---

## Phase 6 — Automation

Eventually automate:

```text
Search
 ↓
Collect
 ↓
Normalize
 ↓
Deduplicate
 ↓
Analyze
 ↓
Detect deals
```

The system should periodically collect new observations and update historical market data.

---

# 🎯 Initial Target Categories

Start with a limited number of categories rather than attempting to analyze all Marketplace products.

Potential categories:

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

The first category should be selected based on:

* High demand
* Reasonable resale value
* Easy transportation
* Low repair risk
* Sufficient Marketplace volume
* Observable price differences

---

# 🔮 Future Features

Potential future improvements:

* Automatic product matching
* Price prediction
* Seller behavior analysis
* Listing-age prediction
* Price-drop alerts
* Telegram notifications
* Deal dashboard
* Category opportunity ranking
* Geographic arbitrage detection
* Resale probability prediction
* Estimated time-to-sale
* Profit forecasting
* Historical market charts
* Personal transaction tracking

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

The project should operate within Facebook's applicable terms and technical restrictions. It should not attempt to bypass authentication, CAPTCHA, rate limits, access controls, or other anti-abuse mechanisms.

The collector should only process data that the user's browser is legitimately able to access.
