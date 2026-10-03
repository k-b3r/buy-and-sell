# Real estate page and worker changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/real-estate` dashboard page (NCR first) fed by a new real estate extraction worker, plus the small worker changes it needs, without changing behavior for any non-real-estate listing.

**Architecture:** Additive only. A side table `real_estate_details` is filled by a new Groq worker `extract-real-estate`. Shared workers (`collect`, `check-listings`) get real-estate-gated behavior that defaults to today's behavior. The dashboard page is a server-rendered route backed by one new whitelisted server query.

**Tech Stack:** TypeScript, Vitest (globals), Postgres 18 (`pg`), Groq structured JSON, Next.js 16 (dashboard), pnpm workspaces (root, `server/`, `dashboard/`).

**Spec:** `docs/superpowers/specs/2026-09-20-real-estate-page-design.md`

## Global Constraints

- **Non-disruption rule (user, 2026-09-20):** nothing may disrupt non-real-estate listings. Existing tests pass unchanged. New behavior on existing code paths is real-estate-gated, defaults to today's behavior, and has a test proving a non-real-estate listing takes the old path. A failed real estate write is logged and swallowed, never failing a shared worker's run.
- **Geography v1:** NCR only. Service area stays 80 km from Manila (`MAX_SERVICE_RADIUS_KM`). No Region 4-A work.
- **Price history:** real estate listings only in v1.
- **Settings values are integers** (`settings.value INTEGER`). New settings default to current behavior: `collect.re_keywords_enabled` = 0, `check_listings.re_recheck_min_days` = 0.
- **Every new setting key** must be added in three places: seed in `db/schema.sql`, `SETTING_DEFAULTS` in `src/platform/settings.ts`, and `SETTING_FLOORS` in `dashboard/src/app/api/settings/route.ts` (a missing floor entry caused a bug before, commit `1f00b53`).
- **New worker keys** must be added in `server/routes/workerControl.ts` (`WORKER_PID_FILES`), `server/routes/logs.ts` (`WORKER_LOG_FILES`), `package.json` scripts, the dashboard `admin/logs/page.tsx` (`WORKERS`, `WORKER_DESCRIPTIONS`) and `admin/settings/page.tsx`.
- **Schema:** additive and idempotent in `db/schema.sql`. Apply schema to prod BEFORE deploying code that reads new columns or tables.
- **Prod deploys are manual and need explicit user go-ahead every time:** `scp` changed files to `/home/scraper/buy-and-sell-ai/`, `chown scraper:scraper`, then restart `buy-and-sell-server.service` (which kills running workers and blips the dashboard, `KillMode=control-group`). Diff each target file first so VPS-only work is not clobbered. Never `git push vps`.
- **Dashboard depends on the VPS server** (`REFRESH_API_KEY` tunnel). Dashboard changes reach prod through the dashboard's own deploy; confirm with the user how that is triggered before merging to `main`.
- **Live Facebook requests are paced.** No burst test scripts. Stage new keywords 3 to 4 at a time.
- **Git:** one branch per phase, branched from `real-estate-page`. Commit messages are imperative, lowercase, concise, no period, and end with the `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer. Never commit a broken build. Commits happen once the user starts a phase. Pushing and deploying need a separate go-ahead.
- **Pause after every phase:** stop, post the phase report (tests, before/after metrics), and wait for the user before the next phase.
- **Test commands:** root `pnpm exec vitest run <path>`; server `cd server && pnpm exec vitest run <path>`; dashboard `cd dashboard && pnpm exec vitest run <path>`. Typecheck with `pnpm exec tsc --noEmit` in each package.
- **Read before writing dashboard code:** `dashboard/AGENTS.md` says this Next version differs from training data. Read the relevant guide in `dashboard/node_modules/next/dist/docs/` before Phase 3 page code.

## File Structure

| File                                                                 | Responsibility                                                                                                         | Phase |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----- |
| `db/schema.sql`                                                      | New table `listing_price_history`, `collect_keywords.kind`, 4 settings seeds, later `real_estate_details` + 2 settings | 1, 2  |
| `src/domains/marketplace/storage/listings.ts`                        | `recordRealEstatePriceChange`, gated call in `refreshListingFields`, `getCheckListingsCandidates(reRecheckMinDays)`    | 1     |
| `src/platform/collect-keywords.ts`                                   | `kind` scoping, `loadRealEstateKeywords`, `planLapQueries`                                                             | 1     |
| `src/workers/collect/index.ts`                                       | Use `planLapQueries`                                                                                                   | 1     |
| `src/workers/check-listings/index.ts`                                | Pass the recheck setting                                                                                               | 1     |
| `src/platform/settings.ts`                                           | New defaults                                                                                                           | 1, 2  |
| `server/queries.ts`                                                  | Scope keyword queries to `kind='general'`; later `getRealEstateListings`                                               | 1, 3  |
| `dashboard/src/app/api/settings/route.ts`, `admin/settings/page.tsx` | Floors and UI fields for new settings                                                                                  | 1, 2  |
| `src/domains/marketplace/real-estate.ts`                             | Pure domain: types, price hints, clamps, NCR normalization, prompt, schema                                             | 2     |
| `src/domains/marketplace/storage/real-estate.ts`                     | Candidates query and upsert                                                                                            | 2     |
| `src/workers/extract-real-estate/index.ts`                           | Batch extraction worker                                                                                                | 2     |
| `dashboard/src/lib/realEstate.ts`                                    | Filter parsing, price/area formatting                                                                                  | 3     |
| `dashboard/src/app/real-estate/page.tsx`, `RealEstateCard.tsx`       | The page                                                                                                               | 3     |

Spec deviations recorded here: (a) the setting is named `check_listings.re_recheck_min_days` to match the existing `check_listings.` prefix; (b) extraction candidates include sold listings (only removed ones are excluded), so later comps can use them; (c) unit conversion (sqft, hectares) is done by the LLM and validated by clamps, since only 1 of 453 listings uses sqft.

---

# Phase 0: keyword agreement (done)

No golden set or eval (user decision 2026-09-20): what the extractor cannot resolve goes to **Under review**, and the user does a ~20-listing spot check at the end of Phase 2. The first collection keyword is just `house and lot`.

**Phase 0 exit:** done. Continue to Phase 1.

---

# Phase 1: price history, recheck cadence, gated real estate collection

Branch: `git checkout -b re-phase-1 real-estate-page`

### Task 1.1: Baseline (tests and prod metrics)

- [ ] **Step 1: Run all three suites and record the pass counts**

```bash
pnpm exec vitest run 2>&1 | tail -5
(cd server && pnpm exec vitest run 2>&1 | tail -5)
(cd dashboard && pnpm exec vitest run 2>&1 | tail -5)
```

Expected: all pass. Record the counts. If anything fails on a clean branch, stop and report before changing code.

- [ ] **Step 2: Record non-real-estate throughput baselines from prod (read-only)**

```bash
cat > /tmp/baseline.sql <<'EOF'
\pset border 1
\echo == non-RE listings first seen per day, last 7 days
SELECT l.first_seen_at::date AS day, count(*) FROM listings l
LEFT JOIN products p ON p.id = l.product_id LEFT JOIN categories c ON c.id = p.category_id
WHERE l.first_seen_at > now() - interval '7 days' AND coalesce(c.name,'') <> 'Real Estate'
GROUP BY 1 ORDER BY 1;
\echo == non-RE listings rechecked in the last 24h
SELECT count(*) FROM listings l
LEFT JOIN products p ON p.id = l.product_id LEFT JOIN categories c ON c.id = p.category_id
WHERE l.last_checked_at > now() - interval '24 hours' AND coalesce(c.name,'') <> 'Real Estate';
EOF
ssh -o BatchMode=yes root@203.0.113.10 'set -a; . /root/bas-db-credentials.env; set +a; PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000" psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1' < /tmp/baseline.sql
ssh -o BatchMode=yes root@203.0.113.10 "grep -E 'lap [0-9]+ (starting|complete)' /home/scraper/buy-and-sell-ai/data/collector.log | tail -6"
```

Record the daily counts, the 24h recheck count, and the last lap timestamps. These are the "before" numbers for the phase report.

### Task 1.2: Real estate price history

**Files:**

- Modify: `db/schema.sql` (append at end of file, before nothing else depends on order)
- Modify: `src/domains/marketplace/storage/listings.ts` (the `refreshListingFields` function and a new exported function above it)
- Test: `src/domains/marketplace/storage/listings.test.ts`

**Interfaces:**

- Produces: `PriorPriceRow`, `recordRealEstatePriceChange(db, logger, listingId, prior, newPrice, newCurrency): Promise<void>`

- [ ] **Step 1: Write the failing tests** (append to `listings.test.ts`)

```ts
function historyDb(opts: {
  prior?: { old_price_amount: string | null; old_price_currency: string | null; old_first_seen_at: string }
  realEstate: boolean
  hasHistory: boolean
  failProbe?: boolean
}): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        if (sql.startsWith('UPDATE listings SET')) return { rows: opts.prior ? [opts.prior] : [] }
        if (sql.includes('FROM listings l') && sql.includes("c.name = 'Real Estate'")) {
          if (opts.failProbe) throw new Error('probe boom')
          return { rows: opts.realEstate ? [{ has_history: opts.hasHistory }] : [] }
        }
        return { rows: [] }
      },
    },
  }
}

const condoListing = (amount: string) => ({
  id: '12345',
  marketplace_listing_title: 'Condo for sale Makati',
  listing_price: { amount, currency: 'PHP' },
  redacted_description: { text: 'Nice unit near Ayala.' },
})

const priorRow = (amount: string | null) => ({
  old_price_amount: amount,
  old_price_currency: 'PHP',
  old_first_seen_at: '2026-08-20T00:00:00.000Z',
})

const historyInserts = (calls: { sql: string; params: unknown[] }[]) =>
  calls.filter((c) => c.sql.includes('INSERT INTO listing_price_history'))

test('refreshListingFields records no price history for a non-real-estate listing whose price changed', async () => {
  const { db, calls } = historyDb({ prior: priorRow('5000000.00'), realEstate: false, hasHistory: false })

  await refreshListingFields(db, fakeImageStore(), fakeLogger(), null, condoListing('4500000.00'))

  expect(historyInserts(calls)).toHaveLength(0)
})

test('refreshListingFields writes a baseline row then the new price on a real estate first price change', async () => {
  const { db, calls } = historyDb({ prior: priorRow('5000000.00'), realEstate: true, hasHistory: false })

  await refreshListingFields(db, fakeImageStore(), fakeLogger(), null, condoListing('4500000.00'))

  const inserts = historyInserts(calls)
  expect(inserts).toHaveLength(2)
  expect(inserts[0].params).toEqual(['12345', 5000000, 'PHP', '2026-08-20T00:00:00.000Z'])
  expect(inserts[1].params).toEqual(['12345', 4500000, 'PHP'])
})

test('refreshListingFields writes only the new price when real estate history already exists', async () => {
  const { db, calls } = historyDb({ prior: priorRow('5000000.00'), realEstate: true, hasHistory: true })

  await refreshListingFields(db, fakeImageStore(), fakeLogger(), null, condoListing('4500000.00'))

  const inserts = historyInserts(calls)
  expect(inserts).toHaveLength(1)
  expect(inserts[0].params).toEqual(['12345', 4500000, 'PHP'])
})

test('refreshListingFields does not even probe when the price is unchanged', async () => {
  const { db, calls } = historyDb({ prior: priorRow('4500000.00'), realEstate: true, hasHistory: false })

  await refreshListingFields(db, fakeImageStore(), fakeLogger(), null, condoListing('4500000.00'))

  expect(calls.filter((c) => c.sql.includes("c.name = 'Real Estate'"))).toHaveLength(0)
  expect(historyInserts(calls)).toHaveLength(0)
})

test('refreshListingFields still completes when the price-history write fails, and logs a warning', async () => {
  const { db, calls } = historyDb({
    prior: priorRow('5000000.00'),
    realEstate: true,
    hasHistory: false,
    failProbe: true,
  })
  const logger = fakeLogger()

  await refreshListingFields(db, fakeImageStore(), logger, null, condoListing('4500000.00'))

  expect(calls[0].sql).toMatch(/^UPDATE listings SET/)
  expect(logger.warnings.some((w) => w.includes('price-history'))).toBe(true)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run src/domains/marketplace/storage/listings.test.ts`
Expected: the 5 new tests FAIL (the UPDATE returns no `RETURNING` handling yet, so no history probe or inserts happen and the failure-warning test finds no warning). All previously passing tests still pass.

- [ ] **Step 3: Add the table** (append to `db/schema.sql`)

```sql
-- Price history for real estate listings only (see
-- docs/superpowers/specs/2026-09-20-real-estate-page-design.md). refreshListingFields
-- overwrites listings.price_amount on every recheck, so a price drop was
-- previously lost. Written only for Real Estate; other categories never touch it.
CREATE TABLE IF NOT EXISTS listing_price_history (
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  price_amount NUMERIC,
  price_currency TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, recorded_at)
);
```

- [ ] **Step 4: Implement** (in `listings.ts`, add above `refreshListingFields`, and change its UPDATE)

```ts
export interface PriorPriceRow {
  old_price_amount: string | number | null
  old_price_currency: string | null
  old_first_seen_at: string | Date
}

// Real estate only: every other category returns early at the probe, so the
// non-real-estate path pays nothing unless its price actually changed (and
// then one indexed SELECT). Best-effort by design - a failure here must never
// fail the listing refresh, so it is logged and swallowed.
export async function recordRealEstatePriceChange(
  db: DbClient,
  logger: Logger,
  listingId: string,
  prior: PriorPriceRow | undefined,
  newPrice: number | null,
  newCurrency: string | null,
): Promise<void> {
  if (!prior) return
  const oldPrice =
    prior.old_price_amount === null || prior.old_price_amount === undefined ? null : Number(prior.old_price_amount)
  if (oldPrice === newPrice) return
  try {
    const probe = (await db.query(
      `SELECT EXISTS (SELECT 1 FROM listing_price_history h WHERE h.listing_id = l.id) AS has_history
       FROM listings l
       JOIN products p ON p.id = l.product_id
       JOIN categories c ON c.id = p.category_id
       WHERE l.id = $1 AND c.name = 'Real Estate'`,
      [listingId],
    )) as { rows?: { has_history: boolean }[] } | undefined
    const row = probe?.rows?.[0]
    if (!row) return
    if (!row.has_history) {
      await db.query(
        `INSERT INTO listing_price_history (listing_id, price_amount, price_currency, recorded_at) VALUES ($1, $2, $3, $4)`,
        [listingId, oldPrice, prior.old_price_currency, prior.old_first_seen_at],
      )
    }
    await db.query(`INSERT INTO listing_price_history (listing_id, price_amount, price_currency) VALUES ($1, $2, $3)`, [
      listingId,
      newPrice,
      newCurrency,
    ])
  } catch (err) {
    logger.warn(
      `listing ${listingId} price-history write failed, continuing: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
```

Then replace the final two lines of `refreshListingFields`:

```ts
await db.query(`UPDATE listings SET ${setClauses.join(', ')} WHERE id = $1`, params)
await flagNegotiableFromKeywords(db, f.id, f.title, f.description)
```

with:

```ts
const updated = (await db.query(
  `UPDATE listings SET ${setClauses.join(', ')}
     FROM (SELECT price_amount AS old_price_amount, price_currency AS old_price_currency, first_seen_at AS old_first_seen_at
           FROM listings WHERE id = $1) prev
     WHERE listings.id = $1
     RETURNING prev.old_price_amount, prev.old_price_currency, prev.old_first_seen_at`,
  params,
)) as { rows?: PriorPriceRow[] } | undefined
await recordRealEstatePriceChange(db, logger, f.id, updated?.rows?.[0], f.priceAmount, f.priceCurrency)
await flagNegotiableFromKeywords(db, f.id, f.title, f.description)
```

- [ ] **Step 5: Run the whole file**

Run: `pnpm exec vitest run src/domains/marketplace/storage/listings.test.ts`
Expected: all PASS, including the untouched existing `refreshListingFields` tests (`/^UPDATE listings SET/`, `toHaveLength(2)`, `source_photo_ids = $8`).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit
git add db/schema.sql src/domains/marketplace/storage/listings.ts src/domains/marketplace/storage/listings.test.ts
git commit -m "record price history for real estate listings" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 1.3: Real estate recheck cadence

**Files:**

- Modify: `src/domains/marketplace/storage/listings.ts` (`getCheckListingsCandidates`)
- Modify: `src/workers/check-listings/index.ts` (settings keys + call)
- Test: `src/domains/marketplace/storage/listings.test.ts`

**Interfaces:**

- Produces: `getCheckListingsCandidates(db, limit, reRecheckMinDays = 0)`

- [ ] **Step 1: Write the failing test** (append; the existing test at line 351 must stay untouched)

```ts
test('getCheckListingsCandidates keeps the original query when reRecheckMinDays is 0', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getCheckListingsCandidates(db, 50, 0)

  expect(calls[0].sql).not.toContain('Real Estate')
  expect(calls[0].params).toEqual([50])
})

test('getCheckListingsCandidates skips recently checked real estate listings only when reRecheckMinDays > 0', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getCheckListingsCandidates(db, 50, 7)

  expect(calls[0].sql).toContain("c.name = 'Real Estate'")
  expect(calls[0].sql).toContain('l.sold_at IS NULL')
  expect(calls[0].sql).toContain('ORDER BY l.last_checked_at ASC NULLS FIRST, l.listed_at ASC NULLS LAST')
  expect(calls[0].params).toEqual([50, 7])
})
```

- [ ] **Step 2: Run to verify the second fails**

Run: `pnpm exec vitest run src/domains/marketplace/storage/listings.test.ts -t getCheckListingsCandidates`
Expected: the "skips recently checked real estate" test FAILS (signature has no third parameter, query lacks the join).

- [ ] **Step 3: Implement** (replace `getCheckListingsCandidates`)

```ts
export async function getCheckListingsCandidates(
  db: DbClient,
  limit: number,
  reRecheckMinDays = 0,
): Promise<CheckListingsCandidate[]> {
  // reRecheckMinDays = 0 (the default) runs the exact original query, so nothing
  // changes for any listing until an operator opts in. When > 0, real estate
  // listings checked within that many days are skipped - property listings
  // change slowly, and every recheck costs live browser time. COALESCE keeps
  // never-checked and non-real-estate rows in (NULL AND ... would drop them).
  const result = (
    reRecheckMinDays > 0
      ? await db.query(
          `SELECT l.id, l.flagged_removed_at, l.source_photo_ids FROM listings l
         LEFT JOIN products p ON p.id = l.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE l.sold_at IS NULL
           AND NOT COALESCE(c.name = 'Real Estate' AND l.last_checked_at > now() - make_interval(days => $2), false)
         ORDER BY l.last_checked_at ASC NULLS FIRST, l.listed_at ASC NULLS LAST
         LIMIT $1`,
          [limit, reRecheckMinDays],
        )
      : await db.query(
          `SELECT id, flagged_removed_at, source_photo_ids FROM listings
         WHERE sold_at IS NULL
         ORDER BY last_checked_at ASC NULLS FIRST, listed_at ASC NULLS LAST
         LIMIT $1`,
          [limit],
        )
  ) as { rows: CheckListingsCandidate[] }
  return result.rows
}
```

- [ ] **Step 4: Wire the worker.** In `src/workers/check-listings/index.ts` add `'check_listings.re_recheck_min_days'` to the `loadSettings` key array and change the candidates call:

```ts
const candidates = await getCheckListingsCandidates(pool, limit, settings['check_listings.re_recheck_min_days'])
```

- [ ] **Step 5: Run and commit**

```bash
pnpm exec vitest run src/domains/marketplace/storage/listings.test.ts
pnpm exec tsc --noEmit
git add src/domains/marketplace/storage/listings.ts src/domains/marketplace/storage/listings.test.ts src/workers/check-listings/index.ts
git commit -m "add opt-in real estate recheck cadence" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Expected: PASS (the `settings[...]` key exists after Task 1.4; `tsc` passes because `loadSettings` returns `Record<string, number>`).

### Task 1.4: Settings for phase 1

**Files:**

- Modify: `db/schema.sql`, `src/platform/settings.ts`, `dashboard/src/app/api/settings/route.ts`, `dashboard/src/app/admin/settings/page.tsx`
- Test: `src/platform/settings.test.ts`

- [ ] **Step 1: Write the failing test** (append to `src/platform/settings.test.ts`)

```ts
test("real estate settings default to today's behavior (collection off, no recheck skipping)", () => {
  expect(SETTING_DEFAULTS['collect.re_keywords_enabled']).toBe(0)
  expect(SETTING_DEFAULTS['check_listings.re_recheck_min_days']).toBe(0)
  expect(SETTING_DEFAULTS['collect.re_every_n_laps']).toBe(3)
  expect(SETTING_DEFAULTS['collect.re_max_items']).toBe(50)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/platform/settings.test.ts`
Expected: FAIL (`undefined` is not `0`).

- [ ] **Step 3: Add defaults** to `SETTING_DEFAULTS` in `src/platform/settings.ts`:

```ts
  'collect.re_keywords_enabled': 0,
  'collect.re_every_n_laps': 3,
  'collect.re_max_items': 50,

  'check_listings.re_recheck_min_days': 0,
```

- [ ] **Step 4: Seed** (append to `db/schema.sql`, after the `listing_price_history` block)

```sql
INSERT INTO settings (key, value) VALUES
  ('collect.re_keywords_enabled', 0),
  ('collect.re_every_n_laps', 3),
  ('collect.re_max_items', 50),
  ('check_listings.re_recheck_min_days', 0)
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 5: Floors.** In `dashboard/src/app/api/settings/route.ts`, add inside `SETTING_FLOORS`:

```ts
  'collect.re_keywords_enabled': 0,
  'collect.re_every_n_laps': 1,
  'collect.re_max_items': 1,
  'check_listings.re_recheck_min_days': 0,
```

- [ ] **Step 6: UI fields.** In `dashboard/src/app/admin/settings/page.tsx`, append these objects to the `fields` array of the `collect` subgroup:

```tsx
          {
            key: 'collect.re_keywords_enabled',
            label: 'Real estate keywords',
            description: '1 = also run the real estate keyword pass; 0 = general keywords only (default).',
            unit: 'count',
            min: 0,
            defaultValue: 0,
          },
          {
            key: 'collect.re_every_n_laps',
            label: 'Real estate pass every N laps',
            description: 'The real estate keyword pass runs on lap 1 and every Nth lap after it.',
            unit: 'count',
            min: 1,
            defaultValue: 3,
          },
          {
            key: 'collect.re_max_items',
            label: 'Max items per real estate query',
            description: 'Per-query item cap during the real estate pass.',
            unit: 'count',
            min: 1,
            defaultValue: 50,
          },
```

and to the `check_listings` subgroup:

```tsx
          {
            key: 'check_listings.re_recheck_min_days',
            label: 'Real estate recheck spacing',
            description: 'Skip real estate listings checked within this many days. 0 = no skipping (default). Other categories are unaffected.',
            unit: 'count',
            min: 0,
            defaultValue: 0,
          },
```

- [ ] **Step 7: Run and commit**

```bash
pnpm exec vitest run src/platform/settings.test.ts
(cd dashboard && pnpm exec tsc --noEmit)
git add db/schema.sql src/platform/settings.ts src/platform/settings.test.ts dashboard/src/app/api/settings/route.ts dashboard/src/app/admin/settings/page.tsx
git commit -m "add real estate collect and recheck settings" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Expected: PASS, dashboard typechecks (a field with an unknown `unit` would fail typecheck: use only `'count'` and `'ms'`, which exist).

### Task 1.5: Keyword `kind` and the gated real estate pass

**Files:**

- Modify: `db/schema.sql`, `src/platform/collect-keywords.ts`, `src/workers/collect/index.ts`, `server/queries.ts`
- Test: `src/platform/collect-keywords.test.ts`, `server/queries.test.ts`

**Interfaces:**

- Produces: `loadRealEstateKeywords(db): Promise<string[]>`, `LapQuery`, `LapPlanInput`, `planLapQueries(input): LapQuery[]`

- [ ] **Step 1: Write the failing tests** (append to `src/platform/collect-keywords.test.ts`; also extend its import to include `loadRealEstateKeywords, planLapQueries`)

```ts
test('loadCollectKeywords only loads general keywords', async () => {
  const { db, calls } = mockDb([{ keyword: 'rush sale' }])
  await loadCollectKeywords(db)
  expect(calls[0].sql).toContain("kind = 'general'")
})

test('loadRealEstateKeywords loads enabled real_estate keywords and never falls back to defaults', async () => {
  const { db, calls } = mockDb([])
  expect(await loadRealEstateKeywords(db)).toEqual([])
  expect(calls[0].sql).toContain("kind = 'real_estate'")
  expect(calls[0].sql).toContain('enabled')
})

const base = {
  general: ['rush sale', 'preloved'],
  realEstate: ['condo for sale makati'],
  reEveryNLaps: 3,
  reMaxItems: 50,
  defaultMaxItems: 100,
}

test('planLapQueries returns only general keywords, unchanged, while the real estate flag is off', () => {
  const plan = planLapQueries({ ...base, lap: 1, reEnabled: 0 })
  expect(plan).toEqual([
    { query: 'rush sale', maxItems: 100 },
    { query: 'preloved', maxItems: 100 },
  ])
})

test('planLapQueries appends the real estate pass on lap 1 and every Nth lap, capped by reMaxItems', () => {
  expect(planLapQueries({ ...base, lap: 1, reEnabled: 1 }).at(-1)).toEqual({
    query: 'condo for sale makati',
    maxItems: 50,
  })
  expect(planLapQueries({ ...base, lap: 2, reEnabled: 1 })).toHaveLength(2)
  expect(planLapQueries({ ...base, lap: 3, reEnabled: 1 })).toHaveLength(2)
  expect(planLapQueries({ ...base, lap: 4, reEnabled: 1 })).toHaveLength(3)
})

test('planLapQueries keeps general keywords first so their order never changes', () => {
  const plan = planLapQueries({ ...base, lap: 1, reEnabled: 1 })
  expect(plan.slice(0, 2).map((p) => p.query)).toEqual(['rush sale', 'preloved'])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run src/platform/collect-keywords.test.ts`
Expected: FAIL (`loadRealEstateKeywords`/`planLapQueries` not exported; the `kind` assertion fails).

- [ ] **Step 3: Add the column** (append to `db/schema.sql`)

```sql
-- 'general' = today's motivated-seller list (default, so every existing row is
-- unchanged). 'real_estate' phrases run in their own capped pass every Nth lap
-- (see planLapQueries) so property searches never lengthen the general lap.
ALTER TABLE collect_keywords ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'general'
  CHECK (kind IN ('general', 'real_estate'));
```

- [ ] **Step 4: Implement** (`src/platform/collect-keywords.ts`: change the existing query and add the rest)

Replace the query inside `loadCollectKeywords`:

```ts
const result = (await db.query(
  "SELECT keyword FROM collect_keywords WHERE enabled AND kind = 'general' ORDER BY keyword",
  [],
)) as {
  rows: { keyword: string }[]
}
```

Append:

```ts
// Real estate phrases only. No default fallback - an empty list just means no
// real estate pass, never a lap with zero queries (the general list guards that).
export async function loadRealEstateKeywords(db: DbClient): Promise<string[]> {
  const result = (await db.query(
    "SELECT keyword FROM collect_keywords WHERE enabled AND kind = 'real_estate' ORDER BY keyword",
    [],
  )) as { rows: { keyword: string }[] }
  return result.rows.map((r) => r.keyword)
}

export interface LapQuery {
  query: string
  maxItems: number
}

export interface LapPlanInput {
  general: string[]
  realEstate: string[]
  lap: number
  reEnabled: number
  reEveryNLaps: number
  reMaxItems: number
  defaultMaxItems: number
}

// General keywords always run first, in the same order and with the same cap
// as before. The real estate pass is appended only when the flag is on and the
// lap is due (lap 1, then every Nth) - so with the flag at its default of 0
// this returns exactly today's list.
export function planLapQueries(input: LapPlanInput): LapQuery[] {
  const plan: LapQuery[] = input.general.map((query) => ({ query, maxItems: input.defaultMaxItems }))
  const due =
    input.reEnabled >= 1 && input.realEstate.length > 0 && (input.lap - 1) % Math.max(1, input.reEveryNLaps) === 0
  if (due) plan.push(...input.realEstate.map((query) => ({ query, maxItems: input.reMaxItems })))
  return plan
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm exec vitest run src/platform/collect-keywords.test.ts`
Expected: all PASS (the existing `WHERE enabled` assertion still holds).

- [ ] **Step 6: Wire `collect`.** In `src/workers/collect/index.ts`:

Change the import: `import { loadCollectKeywords, loadRealEstateKeywords, planLapQueries } from '../../platform/collect-keywords'` and `import type { LapQuery } from '../../platform/collect-keywords'`.

Add the three keys to the `loadSettings` array: `'collect.re_keywords_enabled'`, `'collect.re_every_n_laps'`, `'collect.re_max_items'`.

Replace `const queries = explicitQuery !== undefined ? [explicitQuery] : await loadCollectKeywords(pool)` with:

```ts
const queries: LapQuery[] =
  explicitQuery !== undefined
    ? [{ query: explicitQuery, maxItems }]
    : planLapQueries({
        general: await loadCollectKeywords(pool),
        // Only queried when the flag is on, so flag-off laps do no extra DB work.
        realEstate: settings['collect.re_keywords_enabled'] >= 1 ? await loadRealEstateKeywords(pool) : [],
        lap,
        reEnabled: settings['collect.re_keywords_enabled'],
        reEveryNLaps: settings['collect.re_every_n_laps'],
        reMaxItems: settings['collect.re_max_items'],
        defaultMaxItems: maxItems,
      })
```

In both `for (const query of queries)` loops change to `for (const { query, maxItems: queryMaxItems } of queries)` and, in the `runCollection(...)` options object, replace `maxItems,` with `maxItems: queryMaxItems,`.

- [ ] **Step 7: Scope the dashboard's keyword list to `general`.** The Settings page saves the whole list with `DELETE FROM collect_keywords`, which would wipe real estate rows and, on re-insert, reset `kind`. In `server/queries.ts`:

```ts
export async function getCollectKeywords(db: QueryClient): Promise<CollectKeyword[]> {
  const result = await db.query(
    `SELECT keyword, enabled FROM collect_keywords WHERE kind = 'general' ORDER BY keyword`,
    [],
  )
  return (result.rows as CollectKeyword[]).map((r) => ({ keyword: r.keyword, enabled: r.enabled }))
}
```

and in `replaceCollectKeywords` change the first query to `DELETE FROM collect_keywords WHERE kind = 'general'`. Known edge (documented, not handled): saving a general keyword identical to an existing real estate keyword fails on the primary key.

Append to `server/queries.test.ts`:

```ts
test('getCollectKeywords and replaceCollectKeywords only touch general keywords', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db: QueryClient = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }

  await getCollectKeywords(db)
  await replaceCollectKeywords(db, [{ keyword: 'rush sale', enabled: true }])

  expect(calls[0].sql).toContain("kind = 'general'")
  expect(calls[1].sql).toContain("DELETE FROM collect_keywords WHERE kind = 'general'")
})
```

- [ ] **Step 8: Run everything and commit**

```bash
pnpm exec vitest run
(cd server && pnpm exec vitest run)
pnpm exec tsc --noEmit && (cd server && pnpm exec tsc --noEmit)
git add db/schema.sql src/platform/collect-keywords.ts src/platform/collect-keywords.test.ts src/workers/collect/index.ts server/queries.ts server/queries.test.ts
git commit -m "add gated real estate keyword pass to collect" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Expected: all suites PASS with the same or higher counts than the Task 1.1 baseline, no failures.

### Task 1.6: Phase 1 deploy and verification (needs user go-ahead)

- [ ] **Step 1: Ask the user for a deploy go-ahead and a quiet moment.** Restarting `buy-and-sell-server.service` kills running workers and blips the dashboard.

- [ ] **Step 2: Apply the schema FIRST (additive, safe for the old code)**

```bash
scp db/schema.sql root@203.0.113.10:/tmp/schema.sql
ssh root@203.0.113.10 'set -a; . /root/bas-db-credentials.env; set +a; psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f /tmp/schema.sql 2>&1 | tail -5'
ssh -o BatchMode=yes root@203.0.113.10 'set -a; . /root/bas-db-credentials.env; set +a; psql "$DATABASE_URL" -X -c "\d collect_keywords" -c "SELECT key, value FROM settings WHERE key LIKE '"'"'%re\_%'"'"'" -c "SELECT has_table_privilege(current_user, '"'"'listing_price_history'"'"', '"'"'INSERT'"'"')"'
```

Expected: `kind` column present, 4 settings rows (`0/3/50/0`), privilege `t`. If the privilege is `f`, run `GRANT SELECT, INSERT, UPDATE, DELETE ON listing_price_history TO <app role>;` as the table owner and recheck.

- [ ] **Step 3: Diff each target against prod, then copy** these files to `/home/scraper/buy-and-sell-ai/` with the same relative paths, `chown scraper:scraper`: `src/domains/marketplace/storage/listings.ts`, `src/platform/collect-keywords.ts`, `src/platform/settings.ts`, `src/workers/collect/index.ts`, `src/workers/check-listings/index.ts`, `server/queries.ts`. Restart `buy-and-sell-server.service`.

- [ ] **Step 4: Verify nothing changed with the flag at 0.** Start `collect` and `check-listings` from the dashboard Workers page. Watch `collector.log`: the keyword count in the lap-start line is the same as before and no real estate queries appear. Re-run the Task 1.1 Step 2 queries a few hours later and compare the non-real-estate numbers to baseline.

- [ ] **Step 5: Insert the agreed keyword (inactive while the flag is 0), then enable**

```bash
ssh root@203.0.113.10 'set -a; . /root/bas-db-credentials.env; set +a; psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1' <<'EOF'
INSERT INTO collect_keywords (keyword, kind) VALUES
  ('house and lot', 'real_estate')
ON CONFLICT (keyword) DO NOTHING;
EOF
```

Then, with the user's go-ahead, set `collect.re_keywords_enabled` to 1 on the dashboard Settings page. Watch the next lap in `collector.log` (the real estate queries run after the general ones) and record lap duration.

- [ ] **Step 6: Optionally set `check_listings.re_recheck_min_days`** (for example 7) once real estate volume warrants it. Leave at 0 otherwise.

**Phase 1 exit:** suites green, non-real-estate throughput unchanged versus baseline, real estate price rows appear after price-changing rechecks, the real estate pass verified with the flag on. **Pause and report** (test counts, before/after metrics, lap duration, rows collected).

---

# Phase 2: real estate extractor

Branch: `git checkout -b re-phase-2 re-phase-1` (or from `real-estate-page` if phase 1 was merged).

### Task 2.1: Schema and settings

**Files:**

- Modify: `db/schema.sql`, `src/platform/settings.ts`, `dashboard/src/app/api/settings/route.ts`, `dashboard/src/app/admin/settings/page.tsx`
- Test: `src/platform/settings.test.ts`

- [ ] **Step 1: Write the failing test** (append to `settings.test.ts`)

```ts
test('extract-real-estate settings have defaults', () => {
  expect(SETTING_DEFAULTS['extract_real_estate.batch_size']).toBe(20)
  expect(SETTING_DEFAULTS['extract_real_estate.loop_delay_ms']).toBe(300000)
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `pnpm exec vitest run src/platform/settings.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Add to `SETTING_DEFAULTS`:

```ts
  'extract_real_estate.batch_size': 20,
  'extract_real_estate.loop_delay_ms': 300000,
```

Append to `db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS real_estate_details (
  listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  listing_type TEXT CHECK (listing_type IN ('sale', 'rent')),
  property_type TEXT NOT NULL CHECK (property_type IN ('house_and_lot', 'condo', 'land', 'commercial', 'other')),
  price_php NUMERIC,
  price_basis TEXT NOT NULL CHECK (price_basis IN ('total', 'per_sqm', 'monthly', 'equity', 'unresolved')),
  lot_sqm NUMERIC,
  floor_sqm NUMERIC,
  bedrooms INTEGER,
  bathrooms INTEGER,
  project_name TEXT,
  area_text TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  -- md5 of title|description|price_amount at extraction time. Re-extract when it
  -- differs. listings.updated_at can't be used: refreshListingFields bumps it on
  -- every recheck whether anything changed or not.
  source_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS real_estate_details_type_idx ON real_estate_details (listing_type, property_type);

INSERT INTO settings (key, value) VALUES
  ('extract_real_estate.batch_size', 20),
  ('extract_real_estate.loop_delay_ms', 300000)
ON CONFLICT (key) DO NOTHING;
```

Add to `SETTING_FLOORS`: `'extract_real_estate.batch_size': 1,` and `'extract_real_estate.loop_delay_ms': 1000,`.

Add a subgroup after `enrich_listing_prices` in `admin/settings/page.tsx`:

```tsx
      {
        id: 'extract_real_estate',
        title: 'extract-real-estate',
        fields: [
          {
            key: 'extract_real_estate.batch_size',
            label: 'Batch size',
            description: 'Listings sent to the LLM per extraction request.',
            unit: 'count',
            min: 1,
            defaultValue: 20,
          },
          {
            key: 'extract_real_estate.loop_delay_ms',
            label: 'Loop delay',
            description: 'Pause between laps.',
            unit: 'ms',
            min: 1000,
            defaultValue: 300000,
          },
        ],
      },
```

- [ ] **Step 4: Run and commit**

```bash
pnpm exec vitest run src/platform/settings.test.ts
(cd dashboard && pnpm exec tsc --noEmit)
git add db/schema.sql src/platform/settings.ts src/platform/settings.test.ts dashboard/src/app/api/settings/route.ts dashboard/src/app/admin/settings/page.tsx
git commit -m "add real estate details table and extractor settings" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 2.2: Domain module

**Files:**

- Create: `src/domains/marketplace/real-estate.ts`
- Test: `src/domains/marketplace/real-estate.test.ts`
- Modify: `src/domains/marketplace/index.ts` (add `export * from './real-estate'`)

**Interfaces:**

- Produces (exact): constants `PROPERTY_TYPES`, `LISTING_TYPES`, `PRICE_BASES`, `RE_CONFIDENCES`, `RE_TAGS`, `NCR_LGUS`; types `RealEstateCandidate`, `RealEstateFields`; functions `parsePriceShorthand(text: string): number[]`, `normalizeNcrArea(text: string | null): string | null`, `normalizeRealEstateItem(raw: unknown, candidate: RealEstateCandidate): RealEstateFields | null`, `buildRealEstatePrompt(candidates: RealEstateCandidate[]): string`, `REAL_ESTATE_RESPONSE_SCHEMA`.

- [ ] **Step 1: Write the failing tests** (`src/domains/marketplace/real-estate.test.ts`)

```ts
import {
  parsePriceShorthand,
  normalizeNcrArea,
  normalizeRealEstateItem,
  buildRealEstatePrompt,
  NCR_LGUS,
} from './real-estate'
import type { RealEstateCandidate } from './real-estate'

const candidate = (over: Partial<RealEstateCandidate> = {}): RealEstateCandidate => ({
  id: '1',
  title: 'Condo for sale',
  description: null,
  price_amount: 4500000,
  source_hash: 'h',
  ...over,
})

const raw = (over: Record<string, unknown> = {}) => ({
  id: '1',
  listing_type: 'sale',
  property_type: 'condo',
  price_php: 4500000,
  price_basis: 'total',
  lot_sqm: null,
  floor_sqm: 35,
  bedrooms: 1,
  bathrooms: 1,
  project_name: 'Sheridan Tower',
  area_text: 'Mandaluyong',
  tags: ['rfo'],
  confidence: 'high',
  ...over,
})

test('parsePriceShorthand reads M, mil, k and peso-prefixed amounts', () => {
  expect(parsePriceShorthand('1 bedroom 13M unit')).toEqual([13000000])
  expect(parsePriceShorthand('P1.5M only')).toEqual([1500000])
  expect(parsePriceShorthand('downpayment 500k')).toEqual([500000])
  expect(parsePriceShorthand('2 mil negotiable')).toEqual([2000000])
  expect(parsePriceShorthand('₱ 45k/month')).toEqual([45000])
})

test('parsePriceShorthand ignores areas and dimensions', () => {
  expect(parsePriceShorthand('128 sqm 3-bedroom')).toEqual([])
  expect(parsePriceShorthand('lot 5m x 10m')).toEqual([])
})

test('normalizeNcrArea maps aliases and keeps unknown text as is', () => {
  expect(normalizeNcrArea('BGC')).toBe('Taguig')
  expect(normalizeNcrArea('near Eastwood City')).toBe('Quezon City')
  expect(normalizeNcrArea('las pinas')).toBe('Las Piñas')
  expect(normalizeNcrArea('Makati')).toBe('Makati')
  expect(normalizeNcrArea('Antipolo')).toBe('Antipolo')
  expect(normalizeNcrArea(null)).toBeNull()
  expect(NCR_LGUS).toHaveLength(17)
})

test('normalizeRealEstateItem keeps a valid item as is', () => {
  const f = normalizeRealEstateItem(raw(), candidate())!
  expect(f).toMatchObject({
    listing_type: 'sale',
    property_type: 'condo',
    price_php: 4500000,
    price_basis: 'total',
    floor_sqm: 35,
    bedrooms: 1,
    area_text: 'Mandaluyong',
    confidence: 'high',
    tags: ['rfo'],
  })
})

test('normalizeRealEstateItem treats unknown listing_type as null and unknown property_type as other', () => {
  const f = normalizeRealEstateItem(raw({ listing_type: 'unknown', property_type: 'spaceship' }), candidate())!
  expect(f.listing_type).toBeNull()
  expect(f.property_type).toBe('other')
})

test('normalizeRealEstateItem nulls an implausible price and falls back to a plausible raw price at medium confidence', () => {
  const f = normalizeRealEstateItem(raw({ price_php: 13, price_basis: 'total' }), candidate({ price_amount: 4500000 }))!
  expect(f.price_php).toBe(4500000)
  expect(f.price_basis).toBe('total')
  expect(f.confidence).toBe('medium')
})

test('normalizeRealEstateItem marks price unresolved and confidence low when nothing is plausible', () => {
  const f = normalizeRealEstateItem(
    raw({ price_php: null, price_basis: 'unresolved' }),
    candidate({ price_amount: 13 }),
  )!
  expect(f.price_php).toBeNull()
  expect(f.price_basis).toBe('unresolved')
  expect(f.confidence).toBe('low')
})

test('normalizeRealEstateItem uses monthly as the raw-price fallback basis for rentals', () => {
  const f = normalizeRealEstateItem(
    raw({ listing_type: 'rent', price_php: null, price_basis: 'unresolved' }),
    candidate({ price_amount: 25000 }),
  )!
  expect(f.price_php).toBe(25000)
  expect(f.price_basis).toBe('monthly')
})

test('normalizeRealEstateItem nulls implausible areas and bedroom counts', () => {
  const f = normalizeRealEstateItem(
    raw({ lot_sqm: 99999999, floor_sqm: 0, bedrooms: 400, bathrooms: -2 }),
    candidate(),
  )!
  expect(f.lot_sqm).toBeNull()
  expect(f.floor_sqm).toBeNull()
  expect(f.bedrooms).toBeNull()
  expect(f.bathrooms).toBeNull()
})

test('normalizeRealEstateItem normalizes area_text to an NCR name and drops unknown tags', () => {
  const f = normalizeRealEstateItem(raw({ area_text: 'BGC', tags: ['rfo', 'haunted'] }), candidate())!
  expect(f.area_text).toBe('Taguig')
  expect(f.tags).toEqual(['rfo'])
})

test('normalizeRealEstateItem returns null for a malformed item', () => {
  expect(normalizeRealEstateItem(null, candidate())).toBeNull()
  expect(normalizeRealEstateItem({ id: '1' }, candidate())).toBeNull()
})

test('buildRealEstatePrompt lists each listing with its raw price and text amounts', () => {
  const prompt = buildRealEstatePrompt([candidate({ id: '9', title: '1BR Portico 13M', price_amount: 13 })])
  expect(prompt).toContain('"id":"9"')
  expect(prompt).toContain('"listed_price":13')
  expect(prompt).toContain('13000000')
  expect(prompt).toContain('Taguig')
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `pnpm exec vitest run src/domains/marketplace/real-estate.test.ts`. Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement** (`src/domains/marketplace/real-estate.ts`)

```ts
export const PROPERTY_TYPES = ['house_and_lot', 'condo', 'land', 'commercial', 'other'] as const
export const LISTING_TYPES = ['sale', 'rent'] as const
export const PRICE_BASES = ['total', 'per_sqm', 'monthly', 'equity', 'unresolved'] as const
export const RE_CONFIDENCES = ['high', 'medium', 'low'] as const
export const RE_TAGS = ['pasalo', 'foreclosure', 'rfo', 'preselling', 'has_title', 'furnished'] as const

// The 16 cities plus the one municipality (Pateros) of Metro Manila.
export const NCR_LGUS = [
  'Caloocan',
  'Las Piñas',
  'Makati',
  'Malabon',
  'Mandaluyong',
  'Manila',
  'Marikina',
  'Muntinlupa',
  'Navotas',
  'Parañaque',
  'Pasay',
  'Pasig',
  'Pateros',
  'Quezon City',
  'San Juan',
  'Taguig',
  'Valenzuela',
] as const

export type PropertyType = (typeof PROPERTY_TYPES)[number]
export type ListingType = (typeof LISTING_TYPES)[number]
export type PriceBasis = (typeof PRICE_BASES)[number]
export type RealEstateConfidence = (typeof RE_CONFIDENCES)[number]
export type RealEstateTag = (typeof RE_TAGS)[number]

export interface RealEstateCandidate {
  id: string
  title: string
  description: string | null
  price_amount: number | null
  source_hash: string
}

export interface RealEstateFields {
  listing_type: ListingType | null
  property_type: PropertyType
  price_php: number | null
  price_basis: PriceBasis
  lot_sqm: number | null
  floor_sqm: number | null
  bedrooms: number | null
  bathrooms: number | null
  project_name: string | null
  area_text: string | null
  tags: RealEstateTag[]
  confidence: RealEstateConfidence
}

const UNIT_MULTIPLIER: Record<string, number> = { million: 1e6, mil: 1e6, mn: 1e6, m: 1e6, thousand: 1e3, k: 1e3 }
const SHORTHAND = /(?:₱|php\.?|\bp)?\s?(\d+(?:[.,]\d+)?)\s?(million|mil|mn|m|thousand|k)\b/gi

// Advisory only: shown to the LLM as "amounts the text seems to state". It is
// deliberately liberal (dimensions like "5m x 10m" are filtered, other noise is
// left for the model to discard) because the model, not this, decides the price.
export function parsePriceShorthand(text: string): number[] {
  const found = new Set<number>()
  for (const m of text.matchAll(SHORTHAND)) {
    const after = text.slice((m.index ?? 0) + m[0].length)
    const before = text.slice(0, m.index ?? 0)
    // Skip dimensions like "5m x 10m": the first number is followed by "x <digit>",
    // the second is preceded by "<digit>[m] x".
    if (/^\s*x\s*\d/i.test(after) || /\d\s?m?\s*x\s*$/i.test(before)) continue
    const value = Number(m[1].replace(',', '.')) * UNIT_MULTIPLIER[m[2].toLowerCase()]
    if (Number.isFinite(value) && value >= 500) found.add(Math.round(value))
  }
  return [...found].sort((a, b) => a - b)
}

const NCR_ALIASES: [RegExp, string][] = [
  [/\bbgc\b|\bfort bonifacio\b|\bbonifacio global city\b/i, 'Taguig'],
  [/\balabang\b/i, 'Muntinlupa'],
  [/\beastwood\b/i, 'Quezon City'],
  [/\bqc\b/i, 'Quezon City'],
  [/\blas pinas\b/i, 'Las Piñas'],
  [/\bparanaque\b/i, 'Parañaque'],
]

export function normalizeNcrArea(text: string | null): string | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed) return null
  for (const name of NCR_LGUS) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(trimmed)) return name
  }
  for (const [pattern, name] of NCR_ALIASES) {
    if (pattern.test(trimmed)) return name
  }
  return trimmed.slice(0, 100)
}

const BOUNDS: Record<Exclude<PriceBasis, 'unresolved'>, [number, number]> = {
  total: [100_000, 5_000_000_000],
  monthly: [1_000, 1_000_000],
  per_sqm: [500, 5_000_000],
  equity: [10_000, 50_000_000],
}

function inBounds(basis: PriceBasis, price: number): boolean {
  if (basis === 'unresolved') return false
  const [lo, hi] = BOUNDS[basis]
  return price >= lo && price <= hi
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function boundedOrNull(value: unknown, min: number, max: number): number | null {
  const n = numOrNull(value)
  return n !== null && n >= min && n <= max ? n : null
}

function countOrNull(value: unknown): number | null {
  const n = boundedOrNull(value, 0, 50)
  return n === null ? null : Math.round(n)
}

function stringOrNull(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t ? t.slice(0, max) : null
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null
}

function lowerConfidence(c: RealEstateConfidence, to: RealEstateConfidence): RealEstateConfidence {
  return RE_CONFIDENCES.indexOf(c) >= RE_CONFIDENCES.indexOf(to) ? c : to
}

export function normalizeRealEstateItem(rawItem: unknown, candidate: RealEstateCandidate): RealEstateFields | null {
  if (typeof rawItem !== 'object' || rawItem === null) return null
  const r = rawItem as Record<string, unknown>
  if (typeof r.property_type !== 'string' || typeof r.price_basis !== 'string') return null

  const listingType = oneOf(LISTING_TYPES, r.listing_type)
  const propertyType = oneOf(PROPERTY_TYPES, r.property_type) ?? 'other'
  let confidence = oneOf(RE_CONFIDENCES, r.confidence) ?? 'low'

  const llmBasis = oneOf(PRICE_BASES, r.price_basis) ?? 'unresolved'
  const llmPrice = numOrNull(r.price_php)
  let price: number | null = null
  let basis: PriceBasis = 'unresolved'
  if (llmPrice !== null && inBounds(llmBasis, llmPrice)) {
    price = llmPrice
    basis = llmBasis
  } else {
    const fallbackBasis: PriceBasis = listingType === 'rent' ? 'monthly' : 'total'
    if (candidate.price_amount !== null && inBounds(fallbackBasis, candidate.price_amount)) {
      price = candidate.price_amount
      basis = fallbackBasis
      confidence = lowerConfidence(confidence, 'medium')
    } else {
      confidence = 'low'
    }
  }

  const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is RealEstateTag => oneOf(RE_TAGS, t) !== null) : []

  return {
    listing_type: listingType,
    property_type: propertyType,
    price_php: price,
    price_basis: basis,
    lot_sqm: boundedOrNull(r.lot_sqm, 1, 10_000_000),
    floor_sqm: boundedOrNull(r.floor_sqm, 1, 1_000_000),
    bedrooms: countOrNull(r.bedrooms),
    bathrooms: countOrNull(r.bathrooms),
    project_name: stringOrNull(r.project_name, 120),
    area_text: normalizeNcrArea(stringOrNull(r.area_text, 100)),
    tags,
    confidence,
  }
}

export function buildRealEstatePrompt(candidates: RealEstateCandidate[]): string {
  const lines = candidates
    .map((c) => {
      const description = (c.description ?? '').slice(0, 800)
      return JSON.stringify({
        id: c.id,
        title: c.title,
        listed_price: c.price_amount,
        amounts_in_text: parsePriceShorthand(`${c.title} ${description}`),
        description,
      })
    })
    .join('\n')
  return `Extract structured real estate fields from each Philippine Facebook Marketplace listing below (one JSON object per line).

Rules:
- listing_type: "rent" if it offers a monthly rental or lease; "sale" if it is for sale (including pasalo/assume balance); "unknown" if unclear. Decide from the text, not from anything else.
- property_type: one of ${['house_and_lot', 'condo', 'land', 'commercial', 'other'].join(', ')}.
- listed_price is what the seller typed into Facebook's price field. When it is small it is unreliable (it can mean thousands, hundred-thousands or millions), so never use a small listed_price on its own. amounts_in_text lists amounts found in the text (it can include unrelated numbers). Take the price from the text. If the text states no price and listed_price is not a plausible full price, set price_basis to \"unresolved\" and price_php to null.
- price_php is the price in whole pesos. price_basis says what it is: "total" (full sale price), "per_sqm" (price per square meter), "monthly" (monthly rent), "equity" (only a downpayment or the amount to take over a loan on a pasalo/assume deal), or "unresolved" when you cannot tell (then price_php is null).
- lot_sqm and floor_sqm are in square meters. Convert square feet (x0.0929) and hectares (x10000). Use null when not stated. If the text gives a range, use null.
- bedrooms and bathrooms are counts (0 for a studio); null when not stated.
- project_name is the building, condo or subdivision name as written; null when none.
- area_text is the city or district named in the text. If it is in Metro Manila, use exactly one of: ${NCR_LGUS.join(', ')} (BGC is Taguig). Otherwise copy the place as written. null when not stated.
- tags: any of ${RE_TAGS.join(', ')} that the text clearly states.
- confidence: "high" when the key fields are stated plainly, "medium" when you inferred some, "low" when mostly guessing. Never guess a value: use null.

Listings:
${lines}`
}

const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, 'null'], ...extra })

export const REAL_ESTATE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          listing_type: { type: 'string', enum: ['sale', 'rent', 'unknown'] },
          property_type: { type: 'string', enum: [...PROPERTY_TYPES] },
          price_php: nullable('number'),
          price_basis: { type: 'string', enum: [...PRICE_BASES] },
          lot_sqm: nullable('number'),
          floor_sqm: nullable('number'),
          bedrooms: nullable('number'),
          bathrooms: nullable('number'),
          project_name: nullable('string'),
          area_text: nullable('string'),
          tags: { type: 'array', items: { type: 'string', enum: [...RE_TAGS] } },
          confidence: { type: 'string', enum: [...RE_CONFIDENCES] },
        },
        required: [
          'id',
          'listing_type',
          'property_type',
          'price_php',
          'price_basis',
          'lot_sqm',
          'floor_sqm',
          'bedrooms',
          'bathrooms',
          'project_name',
          'area_text',
          'tags',
          'confidence',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const
```

Add `export * from './real-estate'` to `src/domains/marketplace/index.ts`.

- [ ] **Step 4: Run to verify pass.** Run: `pnpm exec vitest run src/domains/marketplace/real-estate.test.ts`. Expected: all PASS. If a `parsePriceShorthand` case fails, fix the regex, not the test: the expected values encode real prod title patterns.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc --noEmit
git add src/domains/marketplace/real-estate.ts src/domains/marketplace/real-estate.test.ts src/domains/marketplace/index.ts
git commit -m "add real estate extraction domain module" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 2.3: Storage

**Files:**

- Create: `src/domains/marketplace/storage/real-estate.ts`
- Test: `src/domains/marketplace/storage/real-estate.test.ts`
- Modify: `src/domains/marketplace/storage/index.ts` (add `export * from './real-estate'`)

**Interfaces:**

- Consumes: `RealEstateCandidate`, `RealEstateFields` from `../real-estate`
- Produces: `getRealEstateCandidates(db: DbClient, limit: number): Promise<RealEstateCandidate[]>`, `upsertRealEstateDetails(db: DbClient, listingId: string, fields: RealEstateFields, model: string, sourceHash: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
import type { DbClient } from '../../../platform/storage'
import { getRealEstateCandidates, upsertRealEstateDetails } from './real-estate'
import type { RealEstateFields } from '../real-estate'

function recordingDb(rows: unknown[] = []): { db: DbClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return { rows }
      },
    },
  }
}

test('getRealEstateCandidates selects unextracted or changed real estate listings, excluding removed ones', async () => {
  const { db, calls } = recordingDb([
    { id: '1', title: 'Condo', description: 'd', price_amount: '4500000', source_hash: 'abc' },
    { id: '2', title: 'Lot', description: null, price_amount: null, source_hash: 'def' },
  ])

  const result = await getRealEstateCandidates(db, 50)

  expect(calls[0].sql).toContain("c.name = 'Real Estate'")
  expect(calls[0].sql).toContain('flagged_removed_at IS NULL')
  expect(calls[0].sql).toContain('d.listing_id IS NULL')
  expect(calls[0].sql).toContain('d.source_hash IS DISTINCT FROM')
  expect(calls[0].params).toEqual([50])
  expect(result).toEqual([
    { id: '1', title: 'Condo', description: 'd', price_amount: 4500000, source_hash: 'abc' },
    { id: '2', title: 'Lot', description: null, price_amount: null, source_hash: 'def' },
  ])
})

test('upsertRealEstateDetails writes every field in a stable parameter order and re-stamps extracted_at', async () => {
  const { db, calls } = recordingDb()
  const fields: RealEstateFields = {
    listing_type: 'sale',
    property_type: 'condo',
    price_php: 4500000,
    price_basis: 'total',
    lot_sqm: null,
    floor_sqm: 35,
    bedrooms: 1,
    bathrooms: 1,
    project_name: 'Sheridan Tower',
    area_text: 'Mandaluyong',
    tags: ['rfo'],
    confidence: 'high',
  }

  await upsertRealEstateDetails(db, '1', fields, 'openai/gpt-oss-120b', 'abc')

  expect(calls[0].sql).toContain('INSERT INTO real_estate_details')
  expect(calls[0].sql).toContain('ON CONFLICT (listing_id) DO UPDATE')
  expect(calls[0].sql).toContain('extracted_at = now()')
  expect(calls[0].params).toEqual([
    '1',
    'sale',
    'condo',
    4500000,
    'total',
    null,
    35,
    1,
    1,
    'Sheridan Tower',
    'Mandaluyong',
    JSON.stringify(['rfo']),
    'high',
    'abc',
    'openai/gpt-oss-120b',
  ])
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `pnpm exec vitest run src/domains/marketplace/storage/real-estate.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
import type { DbClient } from '../../../platform/storage'
import type { RealEstateCandidate, RealEstateFields } from '../real-estate'

// Computed in SQL both when selecting candidates and (via the value returned
// here) when storing, so the JS side never has to reproduce the hash.
const SOURCE_HASH_SQL = `md5(coalesce(l.title, '') || '|' || coalesce(l.description, '') || '|' || coalesce(l.price_amount::text, ''))`

// Active or sold, never removed. Re-selected when the listing's text or price
// changed since extraction (source_hash differs); listings.updated_at is not
// used because rechecks bump it whether anything changed or not.
export async function getRealEstateCandidates(db: DbClient, limit: number): Promise<RealEstateCandidate[]> {
  const result = (await db.query(
    `SELECT l.id, l.title, l.description, l.price_amount, ${SOURCE_HASH_SQL} AS source_hash
     FROM listings l
     JOIN products p ON p.id = l.product_id
     JOIN categories c ON c.id = p.category_id AND c.name = 'Real Estate'
     LEFT JOIN real_estate_details d ON d.listing_id = l.id
     WHERE l.flagged_removed_at IS NULL
       AND (d.listing_id IS NULL OR d.source_hash IS DISTINCT FROM ${SOURCE_HASH_SQL})
     ORDER BY l.first_seen_at DESC
     LIMIT $1`,
    [limit],
  )) as { rows: Record<string, unknown>[] }
  return result.rows.map((r) => ({
    id: r.id as string,
    title: (r.title as string | null) ?? '',
    description: (r.description as string | null) ?? null,
    price_amount: r.price_amount === null || r.price_amount === undefined ? null : Number(r.price_amount),
    source_hash: r.source_hash as string,
  }))
}

export async function upsertRealEstateDetails(
  db: DbClient,
  listingId: string,
  f: RealEstateFields,
  model: string,
  sourceHash: string,
): Promise<void> {
  await db.query(
    `INSERT INTO real_estate_details
       (listing_id, listing_type, property_type, price_php, price_basis, lot_sqm, floor_sqm, bedrooms, bathrooms,
        project_name, area_text, tags, confidence, source_hash, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15)
     ON CONFLICT (listing_id) DO UPDATE SET
       listing_type = EXCLUDED.listing_type, property_type = EXCLUDED.property_type,
       price_php = EXCLUDED.price_php, price_basis = EXCLUDED.price_basis,
       lot_sqm = EXCLUDED.lot_sqm, floor_sqm = EXCLUDED.floor_sqm,
       bedrooms = EXCLUDED.bedrooms, bathrooms = EXCLUDED.bathrooms,
       project_name = EXCLUDED.project_name, area_text = EXCLUDED.area_text,
       tags = EXCLUDED.tags, confidence = EXCLUDED.confidence,
       source_hash = EXCLUDED.source_hash, model = EXCLUDED.model, extracted_at = now()`,
    [
      listingId,
      f.listing_type,
      f.property_type,
      f.price_php,
      f.price_basis,
      f.lot_sqm,
      f.floor_sqm,
      f.bedrooms,
      f.bathrooms,
      f.project_name,
      f.area_text,
      JSON.stringify(f.tags),
      f.confidence,
      sourceHash,
      model,
    ],
  )
}
```

Add `export * from './real-estate'` to `storage/index.ts`.

- [ ] **Step 4: Run, typecheck, commit**

```bash
pnpm exec vitest run src/domains/marketplace/storage/real-estate.test.ts
pnpm exec tsc --noEmit
git add src/domains/marketplace/storage/real-estate.ts src/domains/marketplace/storage/real-estate.test.ts src/domains/marketplace/storage/index.ts
git commit -m "add real estate candidates query and upsert" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 2.4: Extraction worker

**Files:**

- Create: `src/workers/extract-real-estate/index.ts`
- Test: `src/workers/extract-real-estate/index.test.ts`
- Modify: `package.json`, `server/routes/workerControl.ts`, `server/routes/logs.ts`, `dashboard/src/app/admin/logs/page.tsx`

**Interfaces:**

- Consumes: `buildRealEstatePrompt`, `REAL_ESTATE_RESPONSE_SCHEMA`, `normalizeRealEstateItem`, `RealEstateCandidate`, `RealEstateFields` (from `../../domains/marketplace`); `getRealEstateCandidates`, `upsertRealEstateDetails`
- Produces: `extractRealEstateBatch(groq: GroqClient, logger: Logger, delay: DelayFn, batch: RealEstateCandidate[]): Promise<Map<string, RealEstateFields>>` (throws `QuotaExhaustedError`), `runRealEstateExtraction(groq, db, logger, candidates, batchSize?, delay?): Promise<void>`, `QuotaExhaustedError`

- [ ] **Step 1: Write the failing tests**

```ts
import { existsSync, rmSync } from 'node:fs'
import { extractRealEstateBatch, runRealEstateExtraction } from './index'
import { createLogger } from '../../platform/logger'
import type { GroqClient } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import type { RealEstateCandidate } from '../../domains/marketplace'

const LOG_PATH = 'data/tmp-extract-real-estate.log'
afterEach(() => {
  if (existsSync(LOG_PATH)) rmSync(LOG_PATH)
})

const noDelay = async () => {}
const cand = (id: string, over: Partial<RealEstateCandidate> = {}): RealEstateCandidate => ({
  id,
  title: 'Condo for sale Makati',
  description: null,
  price_amount: 4500000,
  source_hash: `hash-${id}`,
  ...over,
})
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  listing_type: 'sale',
  property_type: 'condo',
  price_php: 4500000,
  price_basis: 'total',
  lot_sqm: null,
  floor_sqm: 35,
  bedrooms: 1,
  bathrooms: 1,
  project_name: null,
  area_text: 'Makati',
  tags: [],
  confidence: 'high',
  ...over,
})

test('extractRealEstateBatch returns normalized fields keyed by listing id and skips unknown ids', async () => {
  const groq: GroqClient = { generateJson: async () => ({ results: [item('1'), item('zzz')] }) }
  const out = await extractRealEstateBatch(groq, createLogger(LOG_PATH), noDelay, [cand('1')])
  expect([...out.keys()]).toEqual(['1'])
  expect(out.get('1')).toMatchObject({ property_type: 'condo', price_php: 4500000 })
})

test('extractRealEstateBatch splits the batch and retries when a request keeps failing', async () => {
  let calls = 0
  const groq: GroqClient = {
    generateJson: async (prompt: string) => {
      calls++
      const ids = [...prompt.matchAll(/"id":"(\w+)"/g)].map((m) => m[1])
      if (ids.length > 1) throw Object.assign(new Error('bad shape'), { status: 400 })
      return { results: ids.map((id) => item(id)) }
    },
  }
  const out = await extractRealEstateBatch(groq, createLogger(LOG_PATH), noDelay, [cand('1'), cand('2')])
  expect([...out.keys()].sort()).toEqual(['1', '2'])
  expect(calls).toBeGreaterThan(2)
})

test('extractRealEstateBatch stops the run on a 429 quota error', async () => {
  const groq: GroqClient = {
    generateJson: async () => {
      throw Object.assign(new Error('quota'), { status: 429 })
    },
  }
  await expect(extractRealEstateBatch(groq, createLogger(LOG_PATH), noDelay, [cand('1')])).rejects.toThrow()
})

test('runRealEstateExtraction upserts each extracted listing with its source hash', async () => {
  const params: unknown[][] = []
  const db: DbClient = {
    query: async (_sql: string, p: unknown[]) => {
      params.push(p)
      return { rows: [] }
    },
  }
  const groq: GroqClient = { generateJson: async () => ({ results: [item('1')] }) }

  await runRealEstateExtraction(groq, db, createLogger(LOG_PATH), [cand('1')], 20, noDelay)

  expect(params).toHaveLength(1)
  expect(params[0][0]).toBe('1')
  expect(params[0][13]).toBe('hash-1')
  expect(params[0][14]).toBe('openai/gpt-oss-120b')
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `pnpm exec vitest run src/workers/extract-real-estate/index.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** (`src/workers/extract-real-estate/index.ts`)

```ts
import { fileURLToPath } from 'node:url'
import type { Logger } from '../../platform/logger'
import { createLogger } from '../../platform/logger'
import type { GroqClient } from '../../domains/llm-clients'
import { createGroqPool, loadGroqApiKeys, summarizeGroqError } from '../../domains/llm-clients'
import type { DbClient } from '../../platform/storage'
import { createDbPool } from '../../platform/storage'
import type { DelayFn } from '../../platform/utils'
import { realDelay, loadEnvFile, isTestRun, writePidFile } from '../../platform/utils'
import { loadSettings } from '../../platform/settings'
import { buildRealEstatePrompt, REAL_ESTATE_RESPONSE_SCHEMA, normalizeRealEstateItem } from '../../domains/marketplace'
import type { RealEstateCandidate, RealEstateFields } from '../../domains/marketplace'
import { getRealEstateCandidates, upsertRealEstateDetails } from '../../domains/marketplace/storage/real-estate'

const MODEL = 'openai/gpt-oss-120b'
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 3000
const LAP_CANDIDATE_LIMIT = 200

// A 429 means the key itself is dead - retrying smaller does not help, so it
// unwinds the whole run (same rule as the sub-category backfill).
export class QuotaExhaustedError extends Error {}

// Same halve-on-persistent-failure recovery the other Groq workers use: a
// smaller array gives the model less room to lose the response shape.
export async function extractRealEstateBatch(
  groq: GroqClient,
  logger: Logger,
  delay: DelayFn,
  batch: RealEstateCandidate[],
): Promise<Map<string, RealEstateFields>> {
  const prompt = buildRealEstatePrompt(batch)
  let raw: { results?: unknown } | undefined

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      raw = (await groq.generateJson(prompt, REAL_ESTATE_RESPONSE_SCHEMA)) as { results?: unknown }
      break
    } catch (err) {
      const message = summarizeGroqError(err)
      if ((err as { status?: unknown }).status === 429) {
        logger.error(`Groq quota exhausted (${message}), stopping run`)
        throw new QuotaExhaustedError(message)
      }
      if (attempt === MAX_ATTEMPTS) {
        if (batch.length === 1) {
          logger.error(
            `listing ${batch[0].id}: Groq failed after ${MAX_ATTEMPTS} attempts at batch size 1 (${message}), skipping`,
          )
          return new Map()
        }
        const mid = Math.ceil(batch.length / 2)
        logger.error(
          `Groq failed after ${MAX_ATTEMPTS} attempts at batch size ${batch.length} (${message}), splitting ${mid} + ${batch.length - mid}`,
        )
        const first = await extractRealEstateBatch(groq, logger, delay, batch.slice(0, mid))
        const second = await extractRealEstateBatch(groq, logger, delay, batch.slice(mid))
        return new Map([...first, ...second])
      }
      logger.warn(`Groq request failed, attempt ${attempt}/${MAX_ATTEMPTS} (${message}), retrying`)
      await delay(RETRY_DELAY_MS)
    }
  }

  const out = new Map<string, RealEstateFields>()
  if (!raw || !Array.isArray(raw.results)) {
    logger.error('unexpected response shape (no results array), skipping batch')
    return out
  }
  for (const item of raw.results as { id?: unknown }[]) {
    const id = typeof item?.id === 'string' ? item.id : null
    const candidate = id === null ? undefined : batch.find((c) => c.id === id)
    if (!candidate) {
      logger.warn(`item ${id ?? '(missing id)'}: no matching candidate in this batch, skipping`)
      continue
    }
    const fields = normalizeRealEstateItem(item, candidate)
    if (!fields) {
      logger.warn(`item ${candidate.id}: malformed fields in Groq response, skipping`)
      continue
    }
    out.set(candidate.id, fields)
  }
  return out
}

export async function runRealEstateExtraction(
  groq: GroqClient,
  db: DbClient,
  logger: Logger,
  candidates: RealEstateCandidate[],
  batchSize = 20,
  delay: DelayFn = realDelay,
): Promise<void> {
  logger.info(`${candidates.length} real estate listings to extract`)
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    let extracted: Map<string, RealEstateFields>
    try {
      extracted = await extractRealEstateBatch(groq, logger, delay, batch)
    } catch (err) {
      if (err instanceof QuotaExhaustedError) return
      throw err
    }
    for (const candidate of batch) {
      const fields = extracted.get(candidate.id)
      if (!fields) continue
      await upsertRealEstateDetails(db, candidate.id, fields, MODEL, candidate.source_hash)
      logger.info(
        `listing ${candidate.id} extracted (${fields.property_type}, price basis ${fields.price_basis}, ${fields.confidence})`,
      )
    }
  }
}

async function main() {
  loadEnvFile()
  const apiKeys = loadGroqApiKeys()
  if (apiKeys.length === 0) throw new Error('No GROQ_API_KEY<n> (GROQ_API_KEY0, GROQ_API_KEY1, ...) set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — real estate extraction requires Postgres')

  const logger = createLogger('data/extract-real-estate.log')
  writePidFile('data/extract-real-estate.pid')
  const groq = createGroqPool(apiKeys, (fromLabel, toLabel) =>
    logger.warn(`Groq ${fromLabel} exhausted, falling back to ${toLabel}`),
  )
  logger.info(`round-robining across ${apiKeys.length} Groq key(s)`)
  const pool = createDbPool(dbUrl)

  logger.info('looping indefinitely — Ctrl+C to stop')
  try {
    let lap = 1
    for (;;) {
      logger.info(`lap ${lap} starting`)
      const candidates = await getRealEstateCandidates(pool, LAP_CANDIDATE_LIMIT)
      const settings = await loadSettings(pool, ['extract_real_estate.batch_size', 'extract_real_estate.loop_delay_ms'])
      if (isTestRun()) {
        logger.info(`TEST_RUN: would call Groq to extract ${candidates.length} real estate listings this lap`)
      } else {
        await runRealEstateExtraction(groq, pool, logger, candidates, settings['extract_real_estate.batch_size'])
      }
      logger.info(`lap ${lap} complete, sleeping ${settings['extract_real_estate.loop_delay_ms']}ms`)
      lap++
      await realDelay(settings['extract_real_estate.loop_delay_ms'])
    }
  } finally {
    await pool.end()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
```

- [ ] **Step 4: Register the worker.**
  - `package.json` scripts: `"extract-real-estate": "tsx src/workers/extract-real-estate/index.ts",`
  - `server/routes/workerControl.ts` `WORKER_PID_FILES`: `'extract-real-estate': 'extract-real-estate.pid',`
  - `server/routes/logs.ts` `WORKER_LOG_FILES`: `'extract-real-estate': 'extract-real-estate.log',`
  - `dashboard/src/app/admin/logs/page.tsx`: add `'extract-real-estate',` to `WORKERS` (after `'enrich-listing-prices'`) and to `WORKER_DESCRIPTIONS`: `'extract-real-estate': 'LLM-extracts structured fields (type, price basis, area, project) from real estate listings.',`

- [ ] **Step 5: Run everything and commit**

```bash
pnpm exec vitest run
(cd server && pnpm exec vitest run)
pnpm exec tsc --noEmit && (cd server && pnpm exec tsc --noEmit) && (cd dashboard && pnpm exec tsc --noEmit)
git add src/workers/extract-real-estate package.json server/routes/workerControl.ts server/routes/logs.ts dashboard/src/app/admin/logs/page.tsx
git commit -m "add extract-real-estate worker" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Expected: all suites PASS; the `Record<Worker, string>` type in the logs page forces `WORKER_DESCRIPTIONS` to include the new key (a typecheck failure means it was missed).

### Task 2.5: Phase 2 deploy, backfill, verification, spot check (needs user go-ahead)

- [ ] **Step 1: Ask the user for a deploy go-ahead.**

- [ ] **Step 2: Apply the schema first**

```bash
scp db/schema.sql root@203.0.113.10:/tmp/schema.sql
ssh root@203.0.113.10 'set -a; . /root/bas-db-credentials.env; set +a; psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f /tmp/schema.sql 2>&1 | tail -5'
ssh -o BatchMode=yes root@203.0.113.10 'set -a; . /root/bas-db-credentials.env; set +a; psql "$DATABASE_URL" -X -c "SELECT has_table_privilege(current_user, '"'"'real_estate_details'"'"', '"'"'INSERT'"'"')"'
```

Expected: privilege `t` (grant it if `f`, then recheck).

- [ ] **Step 3: Diff, then copy** these files with the same relative paths and `chown scraper:scraper`: `src/domains/marketplace/real-estate.ts`, `src/domains/marketplace/index.ts`, `src/domains/marketplace/storage/real-estate.ts`, `src/domains/marketplace/storage/index.ts`, `src/platform/settings.ts`, `src/workers/extract-real-estate/index.ts`, `server/routes/workerControl.ts`, `server/routes/logs.ts`. Restart `buy-and-sell-server.service`.

- [ ] **Step 4: Start `extract-real-estate` from the dashboard Workers page.** Watch `extract-real-estate.log`. It backfills the existing ~450 real estate listings over a few laps.

- [ ] **Step 5: Verify (read-only)**

```bash
ssh -o BatchMode=yes root@203.0.113.10 'set -a; . /root/bas-db-credentials.env; set +a; PGOPTIONS="-c default_transaction_read_only=on" psql "$DATABASE_URL" -X -c "SELECT price_basis, confidence, count(*) FROM real_estate_details GROUP BY 1,2 ORDER BY 1,2" -c "SELECT count(*) AS still_unextracted FROM listings l JOIN products p ON p.id=l.product_id JOIN categories c ON c.id=p.category_id AND c.name='"'"'Real Estate'"'"' LEFT JOIN real_estate_details d ON d.listing_id=l.id WHERE l.flagged_removed_at IS NULL AND d.listing_id IS NULL"'
```

Expected: rows in `real_estate_details`, `still_unextracted` trending to 0, and the share of `unresolved` price basis far below the 42% unusable prices seen before.

- [ ] **Step 6: Spot check with the user.** Show about 20 random extracted listings next to their text (read-only), and ask the user to say which look wrong.

```bash
cat > /tmp/spot.sql <<'SQLEND'
\pset format unaligned
\pset tuples_only on
SELECT '#' || row_number() OVER () || ' ' || l.id || E'\n  RAW ' || coalesce(l.price_amount::text, '-') || ' | ' || left(replace(l.title, E'\n', ' '), 90)
  || E'\n  TXT ' || left(replace(coalesce(l.description, ''), E'\n', ' '), 260)
  || E'\n  OUT ' || coalesce(d.listing_type, '?') || '/' || d.property_type || ' price=' || coalesce(d.price_php::text, '-') || ' ' || d.price_basis
  || ' lot=' || coalesce(d.lot_sqm::text, '-') || ' floor=' || coalesce(d.floor_sqm::text, '-') || ' br=' || coalesce(d.bedrooms::text, '-')
  || ' ' || d.confidence || ' | ' || coalesce(d.project_name, '-') || ' | ' || coalesce(d.area_text, '-')
FROM real_estate_details d JOIN listings l ON l.id = d.listing_id ORDER BY random() LIMIT 20;
SQLEND
ssh -o BatchMode=yes root@203.0.113.10 'set -a; . /root/bas-db-credentials.env; set +a; PGOPTIONS="-c default_transaction_read_only=on" psql "$DATABASE_URL" -X' < /tmp/spot.sql
```

If the user flags wrong rows, fix the cause in `buildRealEstatePrompt` or the clamps (add one failing unit test per rule change in `real-estate.test.ts`), redeploy the domain file, and re-extract by clearing the affected rows' `source_hash`. Stop and ask after 3 rounds without a clean spot check.

**Phase 2 exit:** backfill done, `unresolved` share reported, the user's spot check looks right. **Pause and report** (counts by price basis and confidence, the spot-check result).

---

# Phase 3: query and page

Branch: `git checkout -b re-phase-3 re-phase-2`

### Task 3.1: Server query

**Files:**

- Modify: `server/queries.ts`, `server/routes/query.ts`
- Test: `server/queries.test.ts`, `server/routes/query.test.ts`

**Interfaces:**

- Produces: `RealEstateFilters`, `RealEstateListing`, `getRealEstateListings(db: QueryClient, filters?: RealEstateFilters): Promise<RealEstateListing[]>`

- [ ] **Step 1: Write the failing tests** (append to `server/queries.test.ts`; add `getRealEstateListings` to its import list)

```ts
function recordingDb(rows: Record<string, unknown>[] = []): {
  db: QueryClient
  calls: { sql: string; params: unknown[] }[]
} {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    db: {
      query: async (sql, params) => {
        calls.push({ sql, params })
        return { rows }
      },
    },
  }
}

const reRow = {
  id: '1',
  title: 'Condo',
  primary_photo_url: null,
  stored_photo_urls: null,
  listed_at: null,
  first_seen_at: '2026-09-01T00:00:00.000Z',
  listed_price: '13',
  listing_type: 'sale',
  property_type: 'condo',
  price_php: '13000000',
  price_basis: 'total',
  lot_sqm: null,
  floor_sqm: '35',
  bedrooms: 1,
  bathrooms: 1,
  project_name: 'Portico',
  area_text: 'Pasig',
  tags: ['rfo'],
  confidence: 'high',
  price_per_sqm: '371428.5714',
  needs_review: false,
}

test('getRealEstateListings maps rows, coerces numerics and returns price per sqm', async () => {
  const { db } = recordingDb([reRow])
  const [row] = await getRealEstateListings(db)
  expect(row).toMatchObject({
    id: '1',
    listed_price: 13,
    price_php: 13000000,
    floor_sqm: 35,
    lot_sqm: null,
    tags: ['rfo'],
    price_per_sqm: 371428.5714,
    area_text: 'Pasig',
    confidence: 'high',
  })
})

test('getRealEstateListings shows only active real estate and computes price per sqm from the right area', async () => {
  const { db, calls } = recordingDb()
  await getRealEstateListings(db)
  const sql = calls[0].sql
  expect(sql).toContain('l.sold_at IS NULL')
  expect(sql).toContain('l.flagged_removed_at IS NULL')
  expect(sql).toContain("d.listing_type = 'sale' AND d.price_basis = 'total'")
  expect(sql).toContain("d.property_type IN ('land', 'house_and_lot')")
})

test('getRealEstateListings binds filters as parameters in order and defaults paging', async () => {
  const { db, calls } = recordingDb()
  await getRealEstateListings(db, {
    listingType: 'rent',
    propertyType: 'condo',
    area: 'Makati',
    minPrice: 1000,
    maxPrice: 50000,
    minSqm: 30,
    limit: 10,
    offset: 20,
  })
  expect(calls[0].sql).not.toContain('Makati')
  expect(calls[0].params).toEqual(['rent', 'condo', '%Makati%', 1000, 50000, 30, 10, 20])
})

test('getRealEstateListings caps limit and falls back to newest for an unknown sort', async () => {
  const { db, calls } = recordingDb()
  await getRealEstateListings(db, { limit: 9999, sort: 'drop table' as never })
  expect(calls[0].params.at(-2)).toBe(100)
  expect(calls[0].sql).toContain('COALESCE(x.listed_at, x.first_seen_at) DESC')
})

test('getRealEstateListings excludes listings needing review by default and returns only those for view=review', async () => {
  const main = recordingDb()
  await getRealEstateListings(main.db)
  expect(main.calls[0].sql).toContain('x.needs_review = false')

  const review = recordingDb()
  await getRealEstateListings(review.db, { view: 'review' })
  expect(review.calls[0].sql).toContain('x.needs_review = true')
  expect(review.calls[0].sql).toContain(
    "d.price_basis = 'unresolved' OR d.confidence = 'low' OR d.listing_type IS NULL",
  )
})
```

Append to `server/routes/query.test.ts` next to the other `QUERY_NAMES` assertions:

```ts
test('the registry exposes getRealEstateListings', () => {
  expect(QUERY_NAMES).toContain('getRealEstateListings')
})
```

- [ ] **Step 2: Run to verify they fail.** Run: `cd server && pnpm exec vitest run queries.test.ts routes/query.test.ts`. Expected: FAIL (function/registry entry missing).

- [ ] **Step 3: Implement** (append to `server/queries.ts`; it already defines `toNullableNumber`, `toIsoOrNull`, `resolvePhotoUrls`)

```ts
export interface RealEstateFilters {
  listingType?: 'sale' | 'rent'
  propertyType?: string
  area?: string
  project?: string
  minPrice?: number
  maxPrice?: number
  minSqm?: number
  sort?: 'newest' | 'price_asc' | 'price_desc' | 'ppsqm_asc'
  view?: 'main' | 'review'
  limit?: number
  offset?: number
}

export interface RealEstateListing {
  id: string
  title: string
  primary_photo_url: string | null
  listed_at: string | null
  first_seen_at: string
  listed_price: number | null
  listing_type: 'sale' | 'rent' | null
  property_type: string
  price_php: number | null
  price_basis: string
  lot_sqm: number | null
  floor_sqm: number | null
  bedrooms: number | null
  bathrooms: number | null
  project_name: string | null
  area_text: string | null
  tags: string[]
  confidence: string
  price_per_sqm: number | null
  needs_review: boolean
}

const REAL_ESTATE_SORTS: Record<NonNullable<RealEstateFilters['sort']>, string> = {
  newest: 'COALESCE(x.listed_at, x.first_seen_at) DESC',
  price_asc: 'x.price_php ASC NULLS LAST',
  price_desc: 'x.price_php DESC NULLS LAST',
  ppsqm_asc: 'x.price_per_sqm ASC NULLS LAST',
}

const REAL_ESTATE_MAX_LIMIT = 100

// Active (not sold, not removed) listings that have extracted details. Price per
// sqm is computed here, never stored: a stored value goes stale when a recheck
// changes the price. Only sale listings priced as a total get one - it is
// meaningless for rent, per-sqm or equity prices. Filters are always bound
// parameters; the sort is a whitelist lookup, never interpolated user input.
export async function getRealEstateListings(
  db: QueryClient,
  filters: RealEstateFilters = {},
): Promise<RealEstateListing[]> {
  const where: string[] = []
  const params: unknown[] = []
  const add = (clause: string, value: unknown) => {
    params.push(value)
    where.push(clause.replace('?', `$${params.length}`))
  }
  if (filters.listingType) add('x.listing_type = ?', filters.listingType)
  if (filters.propertyType) add('x.property_type = ?', filters.propertyType)
  if (filters.area) add('x.area_text ILIKE ?', `%${filters.area}%`)
  if (filters.project) add('x.project_name ILIKE ?', `%${filters.project}%`)
  if (filters.minPrice !== undefined) add('x.price_php >= ?', filters.minPrice)
  if (filters.maxPrice !== undefined) add('x.price_php <= ?', filters.maxPrice)
  if (filters.minSqm !== undefined) add('COALESCE(x.lot_sqm, x.floor_sqm) >= ?', filters.minSqm)
  // Main list = listings the extractor could resolve; review list = the ones it could not (price unresolved,
  // low confidence, or sale/rent unclear). The literal comes from a boolean comparison, never user input.
  where.push(`x.needs_review = ${filters.view === 'review'}`)

  const limit = Math.min(Math.max(filters.limit ?? 30, 1), REAL_ESTATE_MAX_LIMIT)
  const offset = Math.max(filters.offset ?? 0, 0)
  const orderBy = REAL_ESTATE_SORTS[filters.sort ?? 'newest'] ?? REAL_ESTATE_SORTS.newest
  params.push(limit, offset)

  const result = await db.query(
    `SELECT * FROM (
       SELECT l.id, l.title, l.primary_photo_url, l.stored_photo_urls, l.listed_at, l.first_seen_at,
              l.price_amount AS listed_price,
              d.listing_type, d.property_type, d.price_php, d.price_basis, d.lot_sqm, d.floor_sqm,
              d.bedrooms, d.bathrooms, d.project_name, d.area_text, d.tags, d.confidence,
              CASE WHEN d.listing_type = 'sale' AND d.price_basis = 'total' AND d.price_php > 0 THEN
                d.price_php / NULLIF(CASE
                  WHEN d.property_type IN ('land', 'house_and_lot') THEN d.lot_sqm
                  WHEN d.property_type = 'condo' THEN d.floor_sqm
                  ELSE COALESCE(d.floor_sqm, d.lot_sqm) END, 0)
              END AS price_per_sqm,
              (d.price_basis = 'unresolved' OR d.confidence = 'low' OR d.listing_type IS NULL) AS needs_review
       FROM real_estate_details d
       JOIN listings l ON l.id = d.listing_id
       WHERE l.sold_at IS NULL AND l.flagged_removed_at IS NULL
     ) x
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${orderBy}, x.id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    primary_photo_url: resolvePhotoUrls(r.stored_photo_urls, r.primary_photo_url)[0] ?? null,
    listed_at: toIsoOrNull(r.listed_at),
    first_seen_at: toIsoOrNull(r.first_seen_at) as string,
    listed_price: toNullableNumber(r.listed_price),
    listing_type: (r.listing_type as 'sale' | 'rent' | null) ?? null,
    property_type: r.property_type as string,
    price_php: toNullableNumber(r.price_php),
    price_basis: r.price_basis as string,
    lot_sqm: toNullableNumber(r.lot_sqm),
    floor_sqm: toNullableNumber(r.floor_sqm),
    bedrooms: (r.bedrooms as number | null) ?? null,
    bathrooms: (r.bathrooms as number | null) ?? null,
    project_name: (r.project_name as string | null) ?? null,
    area_text: (r.area_text as string | null) ?? null,
    tags: (r.tags as string[] | null) ?? [],
    confidence: r.confidence as string,
    price_per_sqm: toNullableNumber(r.price_per_sqm),
    needs_review: r.needs_review === true,
  }))
}
```

In `server/routes/query.ts` add `getRealEstateListings: queries.getRealEstateListings,` to `REGISTRY`.

- [ ] **Step 4: Run and commit**

```bash
(cd server && pnpm exec vitest run && pnpm exec tsc --noEmit)
git add server/queries.ts server/queries.test.ts server/routes/query.ts server/routes/query.test.ts
git commit -m "add real estate listings query" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Expected: PASS. The first test's `price_per_sqm` string `'371428.5714'` becomes a number through `toNullableNumber`.

### Task 3.2: Dashboard helpers and query client

**Files:**

- Create: `dashboard/src/lib/realEstate.ts`
- Test: `dashboard/src/lib/realEstate.test.ts`
- Modify: `dashboard/src/lib/queries.ts`

**Interfaces:**

- Produces: `NCR_AREAS`, `parseRealEstateFilters(params: Record<string, string | undefined>): { filters: RealEstateFilters; page: number }`, `formatPrice(l): string`, `formatAreaLine(l): string`; types `RealEstateFilters`, `RealEstateListing` (in `queries.ts`); `getRealEstateListings(filters?)`.

- [ ] **Step 1: Write the failing tests** (`dashboard/src/lib/realEstate.test.ts`)

```ts
import { parseRealEstateFilters, formatPrice, formatAreaLine, formatReviewReason, NCR_AREAS } from './realEstate'
import type { RealEstateListing } from './queries'

const listing = (over: Partial<RealEstateListing> = {}): RealEstateListing => ({
  id: '1',
  title: 'Condo',
  primary_photo_url: null,
  listed_at: null,
  first_seen_at: '2026-09-01T00:00:00.000Z',
  listed_price: 13,
  listing_type: 'sale',
  property_type: 'condo',
  price_php: 13000000,
  price_basis: 'total',
  lot_sqm: null,
  floor_sqm: 35,
  bedrooms: 1,
  bathrooms: 1,
  project_name: 'Portico',
  area_text: 'Pasig',
  tags: [],
  confidence: 'high',
  price_per_sqm: 371428,
  needs_review: false,
  ...over,
})

test('NCR_AREAS lists the 17 Metro Manila LGUs', () => {
  expect(NCR_AREAS).toHaveLength(17)
})

test('parseRealEstateFilters reads only valid values and computes the page offset', () => {
  const { filters, page } = parseRealEstateFilters({
    kind: 'rent',
    type: 'condo',
    area: 'Makati',
    min: '1000',
    max: '50000',
    sqm: '30',
    sort: 'price_asc',
    page: '3',
  })
  expect(filters).toMatchObject({
    listingType: 'rent',
    propertyType: 'condo',
    area: 'Makati',
    minPrice: 1000,
    maxPrice: 50000,
    minSqm: 30,
    sort: 'price_asc',
    limit: 30,
    offset: 60,
  })
  expect(page).toBe(3)
})

test('parseRealEstateFilters ignores garbage and defaults to page 1', () => {
  const { filters, page } = parseRealEstateFilters({ kind: 'lease', type: 'castle', min: 'abc', sort: 'x', page: '-4' })
  expect(filters.listingType).toBeUndefined()
  expect(filters.propertyType).toBeUndefined()
  expect(filters.minPrice).toBeUndefined()
  expect(filters.sort).toBeUndefined()
  expect(page).toBe(1)
  expect(filters.offset).toBe(0)
})

test('formatPrice shows each price basis in its own terms', () => {
  expect(formatPrice(listing())).toBe('₱13,000,000')
  expect(formatPrice(listing({ listing_type: 'rent', price_basis: 'monthly', price_php: 25000 }))).toBe(
    '₱25,000 / month',
  )
  expect(formatPrice(listing({ price_basis: 'per_sqm', price_php: 90000 }))).toBe('₱90,000 / sqm')
  expect(formatPrice(listing({ price_basis: 'equity', price_php: 500000 }))).toBe('₱500,000 equity')
})

test('formatPrice shows the raw listed price when the price is unresolved', () => {
  expect(formatPrice(listing({ price_basis: 'unresolved', price_php: null, listed_price: 13 }))).toBe(
    'Price unclear (listed as ₱13)',
  )
  expect(formatPrice(listing({ price_basis: 'unresolved', price_php: null, listed_price: null }))).toBe(
    'Price not stated',
  )
})

test('formatAreaLine joins only the facts that exist', () => {
  expect(formatAreaLine(listing())).toBe('35 sqm floor · 1 BR · 1 BA')
  expect(formatAreaLine(listing({ lot_sqm: 120, floor_sqm: 60, bedrooms: null, bathrooms: null }))).toBe(
    '120 sqm lot · 60 sqm floor',
  )
  expect(formatAreaLine(listing({ floor_sqm: null, bedrooms: null, bathrooms: null }))).toBe('')
})

test('formatReviewReason lists why a listing needs review, and is empty for a clear one', () => {
  expect(
    formatReviewReason(listing({ price_basis: 'unresolved', price_php: null, listing_type: null, confidence: 'low' })),
  ).toBe('price not stated, sale or rent unclear, low confidence')
  expect(formatReviewReason(listing())).toBe('')
})

test('parseRealEstateFilters reads the review tab and ignores any other view value', () => {
  expect(parseRealEstateFilters({ view: 'review' }).filters.view).toBe('review')
  expect(parseRealEstateFilters({ view: 'nonsense' }).filters.view).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `cd dashboard && pnpm exec vitest run src/lib/realEstate.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Add to `dashboard/src/lib/queries.ts` (types duplicated from the server by hand, per this file's header comment):

```ts
export interface RealEstateFilters {
  listingType?: 'sale' | 'rent'
  propertyType?: string
  area?: string
  project?: string
  minPrice?: number
  maxPrice?: number
  minSqm?: number
  sort?: 'newest' | 'price_asc' | 'price_desc' | 'ppsqm_asc'
  view?: 'main' | 'review'
  limit?: number
  offset?: number
}

export interface RealEstateListing {
  id: string
  title: string
  primary_photo_url: string | null
  listed_at: string | null
  first_seen_at: string
  listed_price: number | null
  listing_type: 'sale' | 'rent' | null
  property_type: string
  price_php: number | null
  price_basis: string
  lot_sqm: number | null
  floor_sqm: number | null
  bedrooms: number | null
  bathrooms: number | null
  project_name: string | null
  area_text: string | null
  tags: string[]
  confidence: string
  price_per_sqm: number | null
  needs_review: boolean
}

export function getRealEstateListings(filters: RealEstateFilters = {}): Promise<RealEstateListing[]> {
  return rpc('getRealEstateListings', [filters])
}
```

Create `dashboard/src/lib/realEstate.ts` (no server-only imports; only types come from `queries.ts`, so it is safe in any component):

```ts
import type { RealEstateFilters, RealEstateListing } from './queries'

export const NCR_AREAS = [
  'Caloocan',
  'Las Piñas',
  'Makati',
  'Malabon',
  'Mandaluyong',
  'Manila',
  'Marikina',
  'Muntinlupa',
  'Navotas',
  'Parañaque',
  'Pasay',
  'Pasig',
  'Pateros',
  'Quezon City',
  'San Juan',
  'Taguig',
  'Valenzuela',
] as const

export const PROPERTY_TYPE_LABELS: Record<string, string> = {
  house_and_lot: 'House & lot',
  condo: 'Condo',
  land: 'Land',
  commercial: 'Commercial',
  other: 'Other',
}

export const REAL_ESTATE_PAGE_SIZE = 30

const SORTS = ['newest', 'price_asc', 'price_desc', 'ppsqm_asc'] as const

function positiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function parseRealEstateFilters(params: Record<string, string | undefined>): {
  filters: RealEstateFilters
  page: number
} {
  const pageNumber = Number(params.page)
  const page = Number.isInteger(pageNumber) && pageNumber >= 1 ? pageNumber : 1
  const filters: RealEstateFilters = {
    limit: REAL_ESTATE_PAGE_SIZE,
    offset: (page - 1) * REAL_ESTATE_PAGE_SIZE,
  }
  if (params.kind === 'sale' || params.kind === 'rent') filters.listingType = params.kind
  if (params.type && params.type in PROPERTY_TYPE_LABELS) filters.propertyType = params.type
  if (params.area?.trim()) filters.area = params.area.trim()
  if (params.project?.trim()) filters.project = params.project.trim()
  const min = positiveNumber(params.min)
  const max = positiveNumber(params.max)
  const sqm = positiveNumber(params.sqm)
  if (min !== undefined) filters.minPrice = min
  if (max !== undefined) filters.maxPrice = max
  if (sqm !== undefined) filters.minSqm = sqm
  if (params.sort && (SORTS as readonly string[]).includes(params.sort))
    filters.sort = params.sort as RealEstateFilters['sort']
  if (params.view === 'review') filters.view = 'review'
  return { filters, page }
}

const peso = (n: number) => `₱${n.toLocaleString('en-US')}`

export function formatPrice(l: RealEstateListing): string {
  if (l.price_php === null || l.price_basis === 'unresolved') {
    return l.listed_price !== null ? `Price unclear (listed as ${peso(l.listed_price)})` : 'Price not stated'
  }
  if (l.price_basis === 'monthly') return `${peso(l.price_php)} / month`
  if (l.price_basis === 'per_sqm') return `${peso(l.price_php)} / sqm`
  if (l.price_basis === 'equity') return `${peso(l.price_php)} equity`
  return peso(l.price_php)
}

export function formatAreaLine(l: RealEstateListing): string {
  const parts: string[] = []
  if (l.lot_sqm !== null) parts.push(`${l.lot_sqm} sqm lot`)
  if (l.floor_sqm !== null) parts.push(`${l.floor_sqm} sqm floor`)
  if (l.bedrooms !== null) parts.push(`${l.bedrooms} BR`)
  if (l.bathrooms !== null) parts.push(`${l.bathrooms} BA`)
  return parts.join(' · ')
}

// Why a listing is on the Under review tab - mirrors the needs_review rule in
// server/queries.ts (price unresolved, low confidence, or sale/rent unclear).
export function formatReviewReason(l: RealEstateListing): string {
  const reasons: string[] = []
  if (l.price_basis === 'unresolved') reasons.push('price not stated')
  if (l.listing_type === null) reasons.push('sale or rent unclear')
  if (l.confidence === 'low') reasons.push('low confidence')
  return reasons.join(', ')
}
```

- [ ] **Step 4: Run and commit**

```bash
(cd dashboard && pnpm exec vitest run && pnpm exec tsc --noEmit)
git add dashboard/src/lib/realEstate.ts dashboard/src/lib/realEstate.test.ts dashboard/src/lib/queries.ts
git commit -m "add real estate dashboard helpers and query client" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Expected: PASS.

### Task 3.3: The page and nav entry

**Files:**

- Create: `dashboard/src/app/real-estate/page.tsx`, `dashboard/src/app/real-estate/RealEstateCard.tsx`
- Modify: `dashboard/src/app/NavLinks.tsx`

- [ ] **Step 1: Read the framework docs first.** `dashboard/AGENTS.md` requires it. Skim `dashboard/node_modules/next/dist/docs/01-app` for `page` and `searchParams` and confirm `searchParams` is a `Promise` that must be awaited (the existing `dashboard/src/app/page.tsx` line 15 already does exactly this). Adjust the code below only if the docs disagree.

- [ ] **Step 2: Create the card** (`RealEstateCard.tsx`, a server component, inline styles and CSS variables like `saved/SavedListingsClient.tsx`)

```tsx
import Link from 'next/link'
import type { RealEstateListing } from '@/lib/queries'
import { formatAreaLine, formatPrice, formatReviewReason, PROPERTY_TYPE_LABELS } from '@/lib/realEstate'

export default function RealEstateCard({ l }: { l: RealEstateListing }) {
  const area = formatAreaLine(l)
  const where = [l.project_name, l.area_text].filter(Boolean).join(' · ')
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <Link href={`/listings/${l.id}`} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
        <div style={{ width: '100%', aspectRatio: '4 / 3', background: 'var(--color-bg)' }}>
          {l.primary_photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={l.primary_photo_url}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : null}
        </div>
        <div style={{ padding: 10 }}>
          <div style={{ fontSize: '0.9em' }}>{l.title}</div>
          <div style={{ color: 'var(--color-text-muted)', fontSize: '0.8em', marginTop: 2 }}>
            {PROPERTY_TYPE_LABELS[l.property_type] ?? l.property_type}
            {l.listing_type ? ` · ${l.listing_type === 'rent' ? 'For rent' : 'For sale'}` : ''}
          </div>
          {where ? (
            <div style={{ color: 'var(--color-text-muted)', fontSize: '0.8em', marginTop: 2 }}>{where}</div>
          ) : null}
          <div className="mono" style={{ marginTop: 6 }}>
            {formatPrice(l)}
          </div>
          {l.needs_review ? (
            <div style={{ color: 'var(--color-text-muted)', fontSize: '0.8em', marginTop: 4 }}>
              Under review: {formatReviewReason(l)}
            </div>
          ) : null}
          {l.price_per_sqm !== null ? (
            <div style={{ color: 'var(--color-text-muted)', fontSize: '0.8em' }}>
              ₱{Math.round(l.price_per_sqm).toLocaleString('en-US')} / sqm
            </div>
          ) : null}
          {area ? (
            <div style={{ color: 'var(--color-text-muted)', fontSize: '0.85em', marginTop: 2 }}>{area}</div>
          ) : null}
          <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {l.tags.map((t) => (
              <span
                key={t}
                style={{
                  fontSize: '0.75em',
                  border: '1px solid var(--color-border)',
                  borderRadius: 10,
                  padding: '1px 8px',
                }}
              >
                {t.replace('_', ' ')}
              </span>
            ))}
            {l.confidence !== 'high' ? (
              <span style={{ fontSize: '0.75em', color: 'var(--color-text-muted)' }}>{l.confidence} confidence</span>
            ) : null}
          </div>
        </div>
      </Link>
    </div>
  )
}
```

- [ ] **Step 3: Create the page** (`page.tsx`, server-rendered, filters are a plain GET form so no client JS state is needed)

```tsx
import Link from 'next/link'
import { getRealEstateListings } from '@/lib/queries'
import { NCR_AREAS, PROPERTY_TYPE_LABELS, REAL_ESTATE_PAGE_SIZE, parseRealEstateFilters } from '@/lib/realEstate'
import RealEstateCard from './RealEstateCard'

// Live data, same reasoning as deals/page.tsx: prerendering would pin it to
// build time and make every build depend on the VPS server being reachable.
export const dynamic = 'force-dynamic'

type Params = {
  kind?: string
  type?: string
  area?: string
  project?: string
  min?: string
  max?: string
  sqm?: string
  sort?: string
  view?: string
  page?: string
}

const field = {
  padding: '6px 8px',
  background: 'var(--color-surface)',
  color: 'inherit',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
} as const

export default async function RealEstatePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams
  const { filters, page } = parseRealEstateFilters(params)
  const listings = await getRealEstateListings(filters)
  const hasNext = listings.length === REAL_ESTATE_PAGE_SIZE

  const pageHref = (p: number) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries({ ...params, page: String(p) })) if (v) q.set(k, v)
    return `/real-estate?${q.toString()}`
  }

  return (
    <div>
      <h1>Real estate</h1>
      <div style={{ display: 'flex', gap: 16, margin: '12px 0' }}>
        <Link href="/real-estate" style={{ fontWeight: filters.view === 'review' ? 400 : 700 }}>
          Listings
        </Link>
        <Link href="/real-estate?view=review" style={{ fontWeight: filters.view === 'review' ? 700 : 400 }}>
          Under review
        </Link>
      </div>
      <form method="get" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '0 0 20px' }}>
        {filters.view === 'review' ? <input type="hidden" name="view" value="review" /> : null}
        <select name="kind" defaultValue={params.kind ?? ''} style={field}>
          <option value="">Sale &amp; rent</option>
          <option value="sale">For sale</option>
          <option value="rent">For rent</option>
        </select>
        <select name="type" defaultValue={params.type ?? ''} style={field}>
          <option value="">Any type</option>
          {Object.entries(PROPERTY_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select name="area" defaultValue={params.area ?? ''} style={field}>
          <option value="">Any NCR city</option>
          {NCR_AREAS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input name="project" placeholder="Project / building" defaultValue={params.project ?? ''} style={field} />
        <input
          name="min"
          type="number"
          min="0"
          placeholder="Min ₱"
          defaultValue={params.min ?? ''}
          style={{ ...field, width: 110 }}
        />
        <input
          name="max"
          type="number"
          min="0"
          placeholder="Max ₱"
          defaultValue={params.max ?? ''}
          style={{ ...field, width: 110 }}
        />
        <input
          name="sqm"
          type="number"
          min="0"
          placeholder="Min sqm"
          defaultValue={params.sqm ?? ''}
          style={{ ...field, width: 100 }}
        />
        <select name="sort" defaultValue={params.sort ?? ''} style={field}>
          <option value="">Newest</option>
          <option value="price_asc">Price, low to high</option>
          <option value="price_desc">Price, high to low</option>
          <option value="ppsqm_asc">₱/sqm, low to high</option>
        </select>
        <button type="submit" style={{ ...field, cursor: 'pointer' }}>
          Filter
        </button>
      </form>

      {listings.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>No real estate listings match.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {listings.map((l) => (
            <RealEstateCard key={l.id} l={l} />
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, marginTop: 20 }}>
        {page > 1 ? <Link href={pageHref(page - 1)}>← Previous</Link> : null}
        {hasNext ? <Link href={pageHref(page + 1)}>Next →</Link> : null}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Add the nav entry.** In `dashboard/src/app/NavLinks.tsx` add `{ href: '/real-estate', label: 'Real Estate' },` after the Deals entry in `NAV_LINKS`, and update the comment above the component: change "none of these five routes has a nested page today" to "none of these routes has a nested page today".

- [ ] **Step 5: Typecheck, test, build, commit**

```bash
cd dashboard && pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
cd .. && git add dashboard/src/app/real-estate dashboard/src/app/NavLinks.tsx
git commit -m "add real estate page" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Expected: typecheck clean, tests PASS, build succeeds with `/real-estate` listed as dynamic (`ƒ`), not static (`○`). A static `/real-estate` means `export const dynamic` was lost.

### Task 3.4: Verify against real data, then pause (needs user go-ahead for any deploy)

- [ ] **Step 1: Run the stack locally against the VPS database.** Follow the procedure recorded in memory `project_neon_quota_outage_2026_09_04`: open `ssh -N -L 15432:localhost:5432 root@203.0.113.10`, run `server/` and `dashboard/` locally with `DATABASE_URL` pointed at the tunnel (see `server/.env.example` and `dashboard/.env.local` for the variable names). To screenshot authenticated pages, use the cookie-injecting proxy described there, never a saved HTML file over `file://` (hydration fails and looks like an outage). `/api/login` takes form-encoded data.

- [ ] **Step 2: Check `/real-estate` with real rows.** Confirm: cards render with photos, the Listings tab shows only clear listings and the Under review tab shows the unclear ones with a reason, the sale/rent and type filters change results, an NCR area filter works, ₱/sqm shows only on sale listings with a total price, unresolved prices show "Price unclear (listed as ₱…)", low-confidence badges appear, pagination links appear when more than 30 rows match, and clicking a card opens the existing listing modal at `/listings/<id>`.

- [ ] **Step 3: Confirm other pages are unchanged.** Open `/deals`, `/`, `/saved`, `/needs-review` and `/admin/settings`. The nav shows the new "Real Estate" pill without breaking the header at desktop and mobile widths (the hamburger breakpoint in `globals.css` decides when it collapses). Check the Workers page lists `extract-real-estate` and the Settings page shows the new fields.

- [ ] **Step 4: Ask the user how the dashboard deploys** (it is a Vercel deploy per project memory, not the manual VPS copy) and what triggers it, before anything is merged to `main`. Server changes (`server/queries.ts`, `server/routes/query.ts`, `server/routes/workerControl.ts`, `server/routes/logs.ts`) must reach the VPS first, since the deployed dashboard calls `getRealEstateListings` over the tunnel. Diff, `scp`, `chown`, restart, then verify `POST /query` with `{"name":"getRealEstateListings"}` through the tunnel returns rows.

**Phase 3 exit:** page renders real prod rows, low-confidence rows are visibly marked, other pages unchanged. **Pause and report** (screenshots, test counts).

---

# After phase 3 (not planned in detail here)

Phase 4 (more NCR keywords, optional category-scoped search spike) and the later sub-projects (own-listing comps, manual workspace, map view) each get their own short plan after the phase 3 review, informed by the volume and accuracy the extractor actually reaches.
