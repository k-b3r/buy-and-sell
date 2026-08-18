# CONTEXT

## Domain Terms

### Collector
The component that pulls Marketplace listing data into the system.

**Resolved decision (2026-08-17):** No-login, public-JSON extraction — reads the JSON Meta embeds in `<script>` tags on logged-out Marketplace pages. No Facebook session/cookies used, so no personal-account ban risk. Runs against the user's own IP, low-volume, manually-paced (user-triggered runs, not scheduled/continuous automation) to avoid IP-level rate walls. Zero ongoing cost (₱0 budget) — no paid proxy/anti-bot service.

Consequence: no access to login-gated surfaces (private Groups, Pages requiring membership) under this approach. Groups/Pages support is deferred — out of scope for current phase.

**Technical confirmation (2026-08-17):** Plain HTTP fetch (curl) against public Marketplace search returns HTTP 400 from Facebook's edge — bot rejection via missing `Sec-Fetch-*` headers / fingerprint checks, before any login wall is even reached. Confirms a real headless browser (Playwright) is required to extract the embedded JSON, even logged-out. No-login removes *account*-ban risk only; IP-level blocking/fingerprinting risk remains, mitigated by manual-paced runs.

**Observed behavior (2026-08-17, user's manual testing):** Browsing logged-out Marketplace by hand: a few listing navigations work fine, then a login-prompt overlay appears (soft interstitial, not a hard block). Refreshing the page dismisses it and grants another few navigations before it reappears. This is the real rate-limit signal the collector must pace against — not IP ban, a recurring soft wall tied to navigation count within a session.

**Browser mode:** Headed (visible window) chosen for first build — user watches and can intervene manually if a wall/CAPTCHA appears, consistent w/ dry-run/manual-verify approach.

**Wall handling (2026-08-17):** On login-overlay detection, collector pauses and waits up to 5s for user to manually refresh. If no manual refresh within 5s, collector auto-refreshes and continues. Human-first, automation as fallback only.

**Hard block / CAPTCHA (2026-08-17):** Fail closed. If collector detects anything other than the known "safe" soft login-overlay state (e.g. CAPTCHA, hard block), it stops the run entirely and logs the failure — never guesses or retries blindly.

### Collection stages
**Resolved decision (2026-08-17):** Two-stage collection per run. Stage 1: harvest search-results grid only (title, price, thumbnail, location, listing ID/URL) — near-zero navigations, wall rarely triggers. Stage 2: open each listing individually for full detail (description, condition, images) — this is where the login-overlay wall (see Wall handling) actually kicks in, so stage 2 is where pacing/wall-handling logic matters most.

**Flow is sequential, one item at a time (2026-08-17):** After stage-1 grid list is shown, user picks/advances to item 1 → collector opens it (stage 2 detail fetch for that single item) → user validates via y/n (see Review approval mechanism) → only after validation does collector move to item 2, repeat. Not batch-fetch-then-batch-review; one open→validate→next loop.

**Driver (2026-08-17):** Script drives navigation, not user. Collector auto-navigates top-to-bottom through the stage-1 grid, opening each listing in turn (headed browser, visible to user); user only interacts via CLI y/n prompts, doesn't click inside the browser itself. (User's earlier manual testing — clicking listings by hand and hitting the login wall — was exploratory, not the intended v0 driving mode.)

### Pacing delay
**Resolved decision (2026-08-17):** Randomized 4-10s delay between stage-2 listing navigations. Avoids fixed-interval pattern (a bot signature itself), mimics human reading pace.

### Run stop condition
**Resolved decision (2026-08-17):** No upfront fixed count. Per-item prompt is y/n/stop — user can end the run at any point mid-loop. Fits the already-interactive one-item-at-a-time flow.

### Search query
**Resolved decision (2026-08-17):** User supplies one free-text query per run (e.g. "headphones") as a CLI arg/prompt at start. No predefined term list cycling — single query in, single run out. Example query for testing: "headphones".

### Storage (v0)
**Resolved decision (2026-08-17):** Plain JSON file output. No Postgres/DB setup yet — goal is testing the collection implementation itself, not building the full data pipeline. DB schema stays speculative/deferred until real dry-run data has been seen.

### Scope (current phase)
Marketplace public listings only. Groups and Pages buy/sell surfaces are a later phase, revisited once Marketplace-only pipeline works — will need a separate access strategy since no-login can't reach them.

### Collection trigger
**Resolved decision (2026-08-17):** User manually starts each collection run (e.g. "scrape audio equipment now"). No cron/scheduler, no unattended runs. Within a run, the collector self-paces with delays between requests (see [[Collector]]). Verbose logging required so user can manually verify what was scraped/skipped/matched.

### Review workflow
**Resolved decision (2026-08-17):** Dry-run first. Each collection run logs everything scraped (verbosely) to a review artifact; nothing writes to `listings`/DB until user reviews and approves. Auto-save only comes later, once matching/extraction logic is trusted.

### Review approval mechanism
**Resolved decision (2026-08-17):** CLI walks listings one-by-one, y/n prompt per item during dry-run review. Temporary — bootstrap approach until scraping/extraction quality is proven; expect to revisit once volume grows.

### Product identification / canonical matching
**Resolved decision (2026-08-17):** Deferred — premature before real scraped data exists. Priority is proving raw collection works first (Phase 1/2 territory); normalization, market stats, deal scoring all wait until there's actual audio-equipment listing data to look at.

### Field extraction
**Resolved decision (2026-08-17):** Extract whatever fields are actually shown on the page — no fixed schema forced. Stage 1 (grid) captures whatever the grid card shows (title, price, thumbnail, location, listing ID/URL typically); stage 2 (detail) captures whatever the listing page shows (condition, description, images, seller info, etc., whatever's present).

### Logging
**Resolved decision (2026-08-17):** Human-readable, raw is fine — no strict structured format required. Priority is user being able to read and verify what happened.

### Pagination beyond initial batch
**Finding (2026-08-18):** Facebook Marketplace search returns a fixed initial batch of 24 listings via server-rendered embedded JSON, regardless of query — confirmed no scroll/lazy-load triggers any GraphQL request in a logged-out session (0 GraphQL calls observed even after repeated scroll/wheel simulation). However, a genuinely logged-out-context GraphQL pagination call (`x-fb-friendly-name: CometMarketplaceSearchContentPaginationQuery`, `doc_id: 27212616558440397`) was confirmed reachable and returns **HTTP 200** with no wall/block triggered, when called from within the live page's own same-origin context using a real `lsd` token and real `end_cursor` — both of which are already embedded in the initial SSR page (see extraction regexes tested live: `end_cursor` under `page_info`, `lsd` under `["LSD",[],{"token":"..."}]`). One live test returned `edges: []` (empty) despite a valid 200 and cursor advancing (pg 0→1) — likely because the hand-approximated `browse_request_params` in the request body didn't exactly match what the page's own client actually sends; needs the real values extracted from the live page rather than guessed. Deferred to a dedicated future session — see `docs/superpowers/plans/2026-08-18-marketplace-pagination.md`.

### Location filter
**Resolved decision (2026-08-17):** Dasmariñas, Cavite (user's area) — not all-Philippines.

**Technical finding (2026-08-17):** For a logged-out session, Facebook has no reliable location signal via free-text `location=` URL param, browser geolocation permission, or locale/timezone — all confirmed ignored, falling back to a generic US (Bay Area) default regardless. The one thing that works is a recognized location *slug* as a URL path segment (`facebook.com/marketplace/<slug>/search/?query=...`). `manila` is confirmed working and surfaces real PH listings including Dasmarinas/Cavite-area results; `dasmarinas` itself is not a recognized slug. v0 hardcodes `manila`.

### First target category
**Resolved decision (2026-08-17):** Audio equipment — mics, headphones, mixers. Chosen as the first category to build/validate the pipeline against.
