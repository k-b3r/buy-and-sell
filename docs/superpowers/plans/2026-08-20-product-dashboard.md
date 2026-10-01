# Product Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A small, password-gated, read-only Next.js dashboard (deployed to Vercel) for browsing the collected listings/products — specifically to surface "clear variant issues" (products with many listings that haven't been split by variant tier yet) — plus exactly one write feature: defining a product's `variant_tier` enum, which the product-extraction pipeline's Pass 2 (separate plan/repo location, same repo) then consumes.

**Architecture:** A separate Next.js app in `dashboard/` (own `package.json`, own dependency tree — not a shared workspace with the root repo, to keep the two independently deployable/testable) reading the same Neon Postgres database the collector already writes to. App Router, Server Components for all data fetching (no client-side data layer needed for a read-mostly app this size). A single middleware-based cookie check gates every route except `/login`. The one write path (variant enum curation) is a plain form POSTing to a Route Handler.

**Tech Stack:** Next.js (App Router), React, TypeScript, `pg`, Vitest — deployed to Vercel (free Hobby tier).

**Spec:** `CONTEXT.md` — see "Product identification / canonical matching" under Domain Terms, "Dashboard" sub-section of the 2026-08-20 design entry. Depends on the `products`/`variant_enums` schema from `docs/superpowers/plans/2026-08-20-product-extraction.md` (Task 3) — that plan must be applied to the database (`psql "$DATABASE_URL" -f db/schema.sql` from the repo root) before this one is useful, though the dashboard code itself will build fine either way.

## Global Constraints

- ₱0 budget: Vercel free Hobby tier, no paid add-ons.
- Read-only except the variant-enum-curation form — no listing/product edit, approve, reject, or merge UI in this plan (explicitly deferred).
- Password-gated: single shared secret via env var (`DASHBOARD_PASSWORD`) + a cookie, no full auth provider — proportionate to a single-user personal tool. Never store the plaintext password in the cookie (hash it).
- This is a separate package from the root repo (`dashboard/` has its own `package.json`/`node_modules`/`vitest.config.ts`) — do not add it to the root `package.json`'s workspaces or try to share TypeScript types across the two via imports; duplicate the handful of tiny types/helpers that overlap (e.g. a minimal query-client interface). This is a deliberate simplicity choice, not an oversight — a real pnpm workspace is more setup than a single-page dashboard warrants.
- **Testing scope carve-out:** pure logic (password hashing/checking, SQL-result-to-view-model mapping, form-input parsing) is TDD'd with Vitest, same discipline as the rest of this repo. Page/route-handler wiring (the actual `.tsx`/`route.ts` files) is **not** unit tested — React Server Components aren't natural units for Vitest without pulling in a whole testing-library stack this repo doesn't otherwise use. Each task's "verify" step for those files is running `pnpm dev` and checking the real behavior in a browser instead, consistent with how this repo already treats UI verification (see the `run` skill's philosophy: prove it in the running app, not just in a unit test).
- Use `pnpm add <package>`/`pnpm add -D <package>` (no version pins) for all new dependencies in this plan — pinning exact versions here would bake in whatever was current in mid-2026 and could be stale by execution time; let the package manager resolve current versions.

---

### Task 1: Scaffold the Next.js app, password auth, middleware gate

**Files:**

- Create: `dashboard/package.json`, `dashboard/tsconfig.json`, `dashboard/next.config.ts`, `dashboard/vitest.config.ts`
- Create: `dashboard/src/app/layout.tsx`, `dashboard/src/app/page.tsx` (placeholder, replaced properly in Task 2)
- Create: `dashboard/src/lib/auth.ts`
- Create: `dashboard/test/auth.test.ts`
- Create: `dashboard/src/app/login/page.tsx`
- Create: `dashboard/src/app/api/login/route.ts`
- Create: `dashboard/src/middleware.ts`
- Create: `dashboard/.env.local.example`
- Create: `dashboard/.gitignore`

**Interfaces:**

- Produces: `AUTH_COOKIE_NAME` (const), `hashPassword(password: string): string`, `isAuthCookieValid(cookieValue: string | undefined, expectedPassword: string): boolean` — Task 2/3's middleware reasoning and any future auth-touching code depend on these exact names.

- [ ] **Step 1: Create the `dashboard/` directory and initialize the app**

```bash
mkdir dashboard
cd dashboard
pnpm init
pnpm add next react react-dom pg
pnpm add -D typescript @types/node @types/react @types/pg vitest
```

- [ ] **Step 2: Write `dashboard/package.json` scripts**

Edit the generated `dashboard/package.json` so `"scripts"` reads:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run"
  }
}
```

- [ ] **Step 3: Write `dashboard/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Write `dashboard/next.config.ts`**

```ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {}

export default nextConfig
```

- [ ] **Step 5: Write `dashboard/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
})
```

- [ ] **Step 6: Write `dashboard/.gitignore`**

```
node_modules/
.next/
.env.local
```

- [ ] **Step 7: Write `dashboard/.env.local.example`**

```
DATABASE_URL="postgresql://..."
DASHBOARD_PASSWORD="choose-a-real-password-here"
```

Copy this to `dashboard/.env.local` (gitignored) with real values before running `pnpm dev` locally — `DATABASE_URL` is the same Neon connection string already in the root repo's `.env`.

- [ ] **Step 8: Write the failing test for the auth helpers**

```ts
// dashboard/test/auth.test.ts
import { hashPassword, isAuthCookieValid, AUTH_COOKIE_NAME } from '../src/lib/auth'

test('AUTH_COOKIE_NAME is a stable, non-empty cookie name', () => {
  expect(AUTH_COOKIE_NAME).toBe('dashboard_auth')
})

test('hashPassword returns the same hash for the same input, different hashes for different input', () => {
  expect(hashPassword('secret')).toBe(hashPassword('secret'))
  expect(hashPassword('secret')).not.toBe(hashPassword('different'))
})

test('isAuthCookieValid accepts a cookie matching hashPassword(expectedPassword)', () => {
  const expected = 'correct-horse-battery-staple'
  expect(isAuthCookieValid(hashPassword(expected), expected)).toBe(true)
})

test('isAuthCookieValid rejects a missing or wrong cookie', () => {
  const expected = 'correct-horse-battery-staple'
  expect(isAuthCookieValid(undefined, expected)).toBe(false)
  expect(isAuthCookieValid('garbage', expected)).toBe(false)
  expect(isAuthCookieValid(hashPassword('wrong-password'), expected)).toBe(false)
})
```

- [ ] **Step 9: Run test to verify it fails**

Run (from `dashboard/`): `pnpm test`
Expected: FAIL — `src/lib/auth.ts` does not exist yet.

- [ ] **Step 10: Write the implementation**

```ts
// dashboard/src/lib/auth.ts
import { createHash } from 'node:crypto'

export const AUTH_COOKIE_NAME = 'dashboard_auth'

export function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex')
}

export function isAuthCookieValid(cookieValue: string | undefined, expectedPassword: string): boolean {
  if (!cookieValue) return false
  return cookieValue === hashPassword(expectedPassword)
}
```

- [ ] **Step 11: Run test to verify it passes**

Run (from `dashboard/`): `pnpm test`
Expected: PASS (4 tests)

- [ ] **Step 12: Write the root layout**

```tsx
// dashboard/src/app/layout.tsx
export const metadata = {
  title: 'Buy & Sell Dashboard',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem' }}>{children}</body>
    </html>
  )
}
```

- [ ] **Step 13: Write a placeholder home page (Task 2 replaces this with the real products list)**

```tsx
// dashboard/src/app/page.tsx
export default function HomePage() {
  return <p>Dashboard scaffold OK — products list comes in Task 2.</p>
}
```

- [ ] **Step 14: Write the login page**

```tsx
// dashboard/src/app/login/page.tsx
export default function LoginPage() {
  return (
    <form method="POST" action="/api/login" style={{ maxWidth: 320 }}>
      <h1>Dashboard login</h1>
      <input
        type="password"
        name="password"
        placeholder="Password"
        autoFocus
        required
        style={{ width: '100%', padding: 8 }}
      />
      <button type="submit" style={{ marginTop: 8, padding: '8px 16px' }}>
        Log in
      </button>
    </form>
  )
}
```

- [ ] **Step 15: Write the login route handler**

```ts
// dashboard/src/app/api/login/route.ts
import { NextResponse } from 'next/server'
import { AUTH_COOKIE_NAME, hashPassword } from '@/lib/auth'

export async function POST(request: Request) {
  const form = await request.formData()
  const password = form.get('password')
  const expected = process.env.DASHBOARD_PASSWORD

  if (typeof password !== 'string' || !expected || password !== expected) {
    return NextResponse.redirect(new URL('/login?error=1', request.url))
  }

  const response = NextResponse.redirect(new URL('/', request.url))
  response.cookies.set(AUTH_COOKIE_NAME, hashPassword(expected), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  })
  return response
}
```

- [ ] **Step 16: Write the middleware gate**

```ts
// dashboard/src/middleware.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { AUTH_COOKIE_NAME, isAuthCookieValid } from '@/lib/auth'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (pathname === '/login' || pathname === '/api/login') {
    return NextResponse.next()
  }

  const expected = process.env.DASHBOARD_PASSWORD
  const cookie = request.cookies.get(AUTH_COOKIE_NAME)?.value
  if (!expected || !isAuthCookieValid(cookie, expected)) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
}
```

- [ ] **Step 17: Manually verify in a browser**

```bash
cd dashboard
cp .env.local.example .env.local
# edit .env.local: set DATABASE_URL to the real Neon connection string, DASHBOARD_PASSWORD to a real password
pnpm dev
```

Visit `http://localhost:3000` — expect a redirect to `/login`. Submit the wrong password — expect to stay on `/login`. Submit the correct password (matching `.env.local`'s `DASHBOARD_PASSWORD`) — expect a redirect to `/` showing the Task 13 placeholder text, and a `dashboard_auth` cookie set (check DevTools → Application → Cookies).

- [ ] **Step 18: Commit**

```bash
git add dashboard/
git commit -m "scaffold dashboard app with password-gated auth"
```

---

### Task 2: Products list page — the "clear variant issues" view

**Files:**

- Create: `dashboard/src/lib/queries.ts`
- Create: `dashboard/test/queries.test.ts`
- Modify: `dashboard/src/app/page.tsx` (replace Task 1's placeholder)
- Create: `dashboard/src/lib/db.ts`

**Interfaces:**

- Consumes: nothing from Task 1 beyond the auth gate already protecting this route.
- Produces: `QueryClient` interface (`{query(sql: string, params: unknown[]): Promise<{rows: unknown[]}>}`), `ProductSummary` type, `getProductSummaries(db: QueryClient, options?: {onlyUnsplit?: boolean}): Promise<ProductSummary[]>`, `getPool(): QueryClient` (real Postgres connection). Task 3 reuses `QueryClient` and `dashboard/src/lib/db.ts`'s `getPool`.

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/test/queries.test.ts
import { getProductSummaries } from '../src/lib/queries'
import type { QueryClient } from '../src/lib/queries'

function fakeDb(rows: Record<string, unknown>[]): QueryClient {
  return { query: async () => ({ rows }) }
}

test('getProductSummaries maps rows into ProductSummary shape with listing_count as a number', async () => {
  const db = fakeDb([
    { id: 1, base_model: 'RTX 3060', variant_tier: null, listing_count: '12', sample_photo_url: 'https://x/0.jpg' },
    { id: 2, base_model: 'iPhone 13', variant_tier: 'Unknown', listing_count: '3', sample_photo_url: null },
  ])

  const result = await getProductSummaries(db)

  expect(result).toEqual([
    { id: 1, base_model: 'RTX 3060', variant_tier: null, listing_count: 12, sample_photo_url: 'https://x/0.jpg' },
    { id: 2, base_model: 'iPhone 13', variant_tier: 'Unknown', listing_count: 3, sample_photo_url: null },
  ])
})

test('getProductSummaries with onlyUnsplit filters to variant_tier IS NULL in the query', async () => {
  let capturedSql = ''
  const db: QueryClient = {
    query: async (sql) => {
      capturedSql = sql
      return { rows: [] }
    },
  }

  await getProductSummaries(db, { onlyUnsplit: true })

  expect(capturedSql).toContain('variant_tier IS NULL')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `dashboard/`): `pnpm test`
Expected: FAIL — `src/lib/queries.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// dashboard/src/lib/queries.ts
export interface QueryClient {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>
}

export interface ProductSummary {
  id: number
  base_model: string
  variant_tier: string | null
  listing_count: number
  sample_photo_url: string | null
}

export async function getProductSummaries(
  db: QueryClient,
  options: { onlyUnsplit?: boolean } = {},
): Promise<ProductSummary[]> {
  const whereClause = options.onlyUnsplit ? 'WHERE p.variant_tier IS NULL' : ''
  const result = await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, count(l.id) as listing_count,
            max(l.primary_photo_url) as sample_photo_url
     FROM products p
     JOIN listings l ON l.product_id = p.id
     ${whereClause}
     GROUP BY p.id, p.base_model, p.variant_tier
     ORDER BY listing_count DESC`,
    [],
  )
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as number,
    base_model: r.base_model as string,
    variant_tier: r.variant_tier as string | null,
    listing_count: Number(r.listing_count),
    sample_photo_url: r.sample_photo_url as string | null,
  }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `dashboard/`): `pnpm test`
Expected: PASS (all tests including the 2 new ones)

- [ ] **Step 5: Write the real Postgres connection**

```ts
// dashboard/src/lib/db.ts
import { Pool } from 'pg'
import type { QueryClient } from './queries'

let pool: Pool | undefined

export function getPool(): QueryClient {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
  }
  return pool
}
```

- [ ] **Step 6: Write the products list page**

```tsx
// dashboard/src/app/page.tsx
import Link from 'next/link'
import { getPool } from '@/lib/db'
import { getProductSummaries } from '@/lib/queries'

export default async function HomePage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter } = await searchParams
  const onlyUnsplit = filter === 'unsplit'
  const products = await getProductSummaries(getPool(), { onlyUnsplit })

  return (
    <div>
      <h1>Products ({products.length})</h1>
      <p>
        {onlyUnsplit ? (
          <Link href="/">Show all products</Link>
        ) : (
          <Link href="/?filter=unsplit">Show only un-split products (candidates for variant review)</Link>
        )}
      </p>
      <table cellPadding={8} style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #ccc' }}>
            <th></th>
            <th>Base model</th>
            <th>Variant tier</th>
            <th>Listings</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id} style={{ borderBottom: '1px solid #eee' }}>
              <td>
                {p.sample_photo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.sample_photo_url} alt="" width={48} height={48} style={{ objectFit: 'cover' }} />
                ) : null}
              </td>
              <td>
                <Link href={`/products/${p.id}`}>{p.base_model}</Link>
              </td>
              <td>{p.variant_tier ?? '—'}</td>
              <td>{p.listing_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 7: Manually verify in a browser**

Run: `pnpm dev` (from `dashboard/`, with a real `DATABASE_URL` in `.env.local`)
Visit `http://localhost:3000` after logging in — expect a table of real products ordered by listing count descending, with thumbnails for products that have `stored_photo_urls`. Click "Show only un-split products" — expect the list to narrow to `variant_tier IS NULL` rows only. Note: if `pnpm run extract-products` (the other plan) hasn't been run yet against this database, this table will be empty — that's expected, not a bug; verify the empty state doesn't crash the page.

- [ ] **Step 8: Commit**

```bash
git add dashboard/
git commit -m "add products list page with un-split filter"
```

---

### Task 3: Product detail page + variant enum curation form

**Files:**

- Modify: `dashboard/src/lib/queries.ts` (add `getProductDetail`, `parseEnumValuesInput`)
- Modify: `dashboard/test/queries.test.ts` (add tests for the above)
- Create: `dashboard/src/app/products/[id]/page.tsx`
- Create: `dashboard/src/app/api/variant-enums/route.ts`

**Interfaces:**

- Consumes: `QueryClient`, `getPool` (Task 2).
- Produces: `getProductDetail(db: QueryClient, productId: number): Promise<ProductDetail | null>`, `parseEnumValuesInput(raw: string): string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to dashboard/test/queries.test.ts
import { getProductDetail, parseEnumValuesInput } from '../src/lib/queries'

test('parseEnumValuesInput splits on commas, trims, dedupes, and drops empty entries', () => {
  expect(parseEnumValuesInput('Reference/Founders Edition, Custom AIB/OC,, Custom AIB/OC ,  ')).toEqual([
    'Reference/Founders Edition',
    'Custom AIB/OC',
  ])
})

test('getProductDetail returns null when the product does not exist', async () => {
  const db = fakeDb([])
  const result = await getProductDetail(db, 999)
  expect(result).toBeNull()
})

test('getProductDetail returns the product plus its listings', async () => {
  let call = 0
  const db: QueryClient = {
    query: async () => {
      call += 1
      if (call === 1) {
        return { rows: [{ id: 1, base_model: 'RTX 3060', base_model_normalized: 'rtx 3060', variant_tier: null }] }
      }
      return {
        rows: [{ id: '123', title: 'RTX 3060 OC Asus', price_amount: '15000', primary_photo_url: 'https://x/0.jpg' }],
      }
    },
  }

  const result = await getProductDetail(db, 1)

  expect(result).toEqual({
    id: 1,
    base_model: 'RTX 3060',
    base_model_normalized: 'rtx 3060',
    variant_tier: null,
    listings: [{ id: '123', title: 'RTX 3060 OC Asus', price_amount: 15000, primary_photo_url: 'https://x/0.jpg' }],
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `dashboard/`): `pnpm test`
Expected: FAIL — `getProductDetail`/`parseEnumValuesInput` not exported yet.

- [ ] **Step 3: Write the implementation**

```ts
// append to dashboard/src/lib/queries.ts
export interface ProductListingSummary {
  id: string
  title: string
  price_amount: number | null
  primary_photo_url: string | null
}

export interface ProductDetail {
  id: number
  base_model: string
  base_model_normalized: string
  variant_tier: string | null
  listings: ProductListingSummary[]
}

export async function getProductDetail(db: QueryClient, productId: number): Promise<ProductDetail | null> {
  const productResult = await db.query(
    `SELECT id, base_model, base_model_normalized, variant_tier FROM products WHERE id = $1`,
    [productId],
  )
  const productRow = (productResult.rows as Record<string, unknown>[])[0]
  if (!productRow) return null

  const listingsResult = await db.query(
    `SELECT id, title, price_amount, primary_photo_url FROM listings WHERE product_id = $1 ORDER BY title`,
    [productId],
  )
  const listings = (listingsResult.rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    price_amount: r.price_amount === null ? null : Number(r.price_amount),
    primary_photo_url: r.primary_photo_url as string | null,
  }))

  return {
    id: productRow.id as number,
    base_model: productRow.base_model as string,
    base_model_normalized: productRow.base_model_normalized as string,
    variant_tier: productRow.variant_tier as string | null,
    listings,
  }
}

export function parseEnumValuesInput(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (trimmed) seen.add(trimmed)
  }
  return [...seen]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `dashboard/`): `pnpm test`
Expected: PASS (all tests including the 3 new ones)

- [ ] **Step 5: Write the variant-enums route handler**

```ts
// dashboard/src/app/api/variant-enums/route.ts
import { NextResponse } from 'next/server'
import { getPool } from '@/lib/db'
import { parseEnumValuesInput } from '@/lib/queries'

export async function POST(request: Request) {
  const form = await request.formData()
  const productId = Number(form.get('product_id'))
  const rawEnumValues = form.get('enum_values')

  if (!Number.isInteger(productId) || typeof rawEnumValues !== 'string') {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 })
  }

  const enumValues = parseEnumValuesInput(rawEnumValues)
  if (enumValues.length < 2) {
    return NextResponse.json({ error: 'need at least 2 variant values' }, { status: 400 })
  }

  const db = getPool()
  const productResult = await db.query('SELECT base_model_normalized FROM products WHERE id = $1', [productId])
  const productRow = (productResult.rows as { base_model_normalized: string }[])[0]
  if (!productRow) {
    return NextResponse.json({ error: 'product not found' }, { status: 404 })
  }

  await db.query(
    `INSERT INTO variant_enums (base_model_normalized, enum_values)
     VALUES ($1, $2)
     ON CONFLICT (base_model_normalized) DO UPDATE SET enum_values = EXCLUDED.enum_values`,
    [productRow.base_model_normalized, JSON.stringify(enumValues)],
  )

  return NextResponse.redirect(new URL(`/products/${productId}?saved=1`, request.url))
}
```

- [ ] **Step 6: Write the product detail page**

```tsx
// dashboard/src/app/products/[id]/page.tsx
import { notFound } from 'next/navigation'
import { getPool } from '@/lib/db'
import { getProductDetail } from '@/lib/queries'

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ saved?: string }>
}) {
  const { id } = await params
  const { saved } = await searchParams
  const productId = Number(id)
  const product = await getProductDetail(getPool(), productId)
  if (!product) notFound()

  return (
    <div>
      <p>
        <a href="/">← Back to products</a>
      </p>
      <h1>{product.base_model}</h1>
      <p>Variant tier: {product.variant_tier ?? '— not split yet'}</p>
      {saved === '1' && (
        <p style={{ color: 'green' }}>Variant enum saved — pnpm run variant-classify will pick it up.</p>
      )}

      {product.variant_tier === null && (
        <form method="POST" action="/api/variant-enums" style={{ margin: '1rem 0', maxWidth: 480 }}>
          <input type="hidden" name="product_id" value={product.id} />
          <label>
            Define this product&apos;s variant tiers (comma-separated, at least 2):
            <input
              type="text"
              name="enum_values"
              placeholder="Reference/Founders Edition, Custom AIB/OC, Unknown"
              style={{ width: '100%', padding: 8, marginTop: 4 }}
              required
            />
          </label>
          <button type="submit" style={{ marginTop: 8, padding: '8px 16px' }}>
            Save variant enum
          </button>
        </form>
      )}

      <h2>Listings ({product.listings.length})</h2>
      <table cellPadding={8} style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #ccc' }}>
            <th></th>
            <th>Title</th>
            <th>Price</th>
          </tr>
        </thead>
        <tbody>
          {product.listings.map((l) => (
            <tr key={l.id} style={{ borderBottom: '1px solid #eee' }}>
              <td>
                {l.primary_photo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={l.primary_photo_url} alt="" width={48} height={48} style={{ objectFit: 'cover' }} />
                ) : null}
              </td>
              <td>
                <a href={`https://www.facebook.com/marketplace/item/${l.id}/`} target="_blank" rel="noreferrer">
                  {l.title}
                </a>
              </td>
              <td>{l.price_amount !== null ? `₱${l.price_amount.toLocaleString()}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 7: Manually verify in a browser**

Run: `pnpm dev` (from `dashboard/`)
Click into a product from the home page's list. Confirm: all its listings show with titles/prices/thumbnails, each title links out to the real Facebook Marketplace listing. For a product with `variant_tier` still null, confirm the enum-definition form appears; submit e.g. `Reference/Founders Edition, Custom AIB/OC` and confirm it redirects back with the "saved" message. Verify in the database directly (`psql "$DATABASE_URL" -c "SELECT * FROM variant_enums;"`) that the row was written with the right `base_model_normalized` and `enum_values`. For a product that already has a `variant_tier` set (non-null — won't exist until Pass 2 has run at least once; can be faked with a manual `UPDATE products SET variant_tier = 'test' WHERE id = ...` for this check only, then revert), confirm the form does **not** appear.

- [ ] **Step 8: Commit**

```bash
git add dashboard/
git commit -m "add product detail page with variant enum curation form"
```

---

### Task 4: Deploy to Vercel

**Files:** none (infrastructure/config task, no new source)

- [ ] **Step 1: Push the `dashboard/` directory to the repo's remote**

```bash
git push
```

(Should already be pushed via each task's commits — this step just confirms the remote is current before connecting Vercel to it.)

- [ ] **Step 2: Create the Vercel project**

In the Vercel dashboard: New Project → import the `k-b3r/buy-and-sell-ai` GitHub repo → set **Root Directory** to `dashboard` (critical — this repo has the Next.js app in a subdirectory, not the root) → Framework Preset should auto-detect as Next.js once the root directory is set correctly.

- [ ] **Step 3: Set environment variables in the Vercel project settings**

Add `DATABASE_URL` (same Neon connection string as the root repo's `.env`) and `DASHBOARD_PASSWORD` (a real password — does not need to match anything else) under Project Settings → Environment Variables, for the Production environment (and Preview if you want preview deploys to work too).

- [ ] **Step 4: Deploy and verify**

Trigger a deploy (either automatic on push, or manually via the Vercel dashboard). Once live, visit the assigned `*.vercel.app` URL — expect the same login-gate → products-list → product-detail flow verified locally in Tasks 1-3, now against the real deployed app.

- [ ] **Step 5: Update the repo's README with the dashboard section**

Add to `README.md` (root repo):

```markdown
## Dashboard

Read-only product/listing browser + variant-tier curation, deployed separately to Vercel from `dashboard/`. See `dashboard/README.md` (if present) or `docs/superpowers/plans/2026-08-20-product-dashboard.md` for setup. Requires `DATABASE_URL` and `DASHBOARD_PASSWORD` env vars in the Vercel project (not the root `.env`).
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "document dashboard deployment"
```
