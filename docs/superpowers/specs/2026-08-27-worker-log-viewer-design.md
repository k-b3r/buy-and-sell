# Worker Log Viewer — Design

**Goal:** View the live logs of any of the 7 workers from the dashboard, without SSH.

**Status:** Approved by user 2026-08-27. Ready for implementation plan.

## Context

Workers (`src/workers/*`) run continuously on the Hetzner VPS, each writing
plain-text lines via `createLogger` (`src/platform/logger.ts`) to its own file
under `data/`:

| Worker | Log file |
|---|---|
| collect | `data/collector.log` |
| check-listings | `data/check-listings.log` |
| extract-products | `data/extract-products.log` |
| enrich-products | `data/enrich-products.log` |
| secondhand-price-lookup | `data/secondhand-price-lookup.log` |
| retail-price-lookup | `data/retail-price-lookup.log` |
| enrich-listing-prices | `data/enrich-listing-prices.log` |

Log line format: `[ISO timestamp] [INFO|WARN|ERROR] message` (one line per
call to `logger.info/warn/error`).

`server/` (the "refresh" companion service) already runs continuously on the
**same Hetzner VPS**, same filesystem, and is already the dashboard's only
path to anything Hetzner-side (Vercel can't run Playwright or reach the VPS
directly — see `dashboard/src/app/api/listings/[id]/refresh/route.ts`). It
already has one shared Bearer-token auth (`REFRESH_API_KEY`) covering every
route via `createApp`'s `handleRequest` (`server/app.ts`). The dashboard
already has a working proxy pattern for this (`dashboard/src/app/api/refresh-job/route.ts`
→ `server/routes/refreshJob.ts`), and the whole dashboard is already gated by
one shared-password cookie check in `dashboard/src/proxy.ts` (Next.js
middleware), covering every route except `/login`, `/api/login`, `/robots.txt`.

This feature reuses all three of those existing mechanisms as-is — no new
auth, no new transport, no new deploy step.

## Non-goals

- Real-time push (SSE/WebSocket). Polling only, matching the existing
  `refresh-job` pattern.
- Log rotation, retention, deletion, or download. Logs keep growing
  unbounded exactly as they do today; this feature only reads them.
- Search/filter/highlight within a log. Plain scrolling view only.
- Any change to `createLogger` or worker code. Log files are read as-is.

## Backend: `server/routes/logs.ts`

New route: `POST /logs`, registered in `server/index.ts`'s route table
alongside the existing four.

**Request body:** `{ worker: string, offset?: number }`

**Worker validation:** `worker` must be one of the 7 keys in a fixed
allowlist map (see below) — reject anything else with `400`. The client
never supplies a file path, only a key; this closes off path traversal by
construction, not by sanitizing input.

```ts
const WORKER_LOG_FILES: Record<string, string> = {
  collect: 'collector.log',
  'check-listings': 'check-listings.log',
  'extract-products': 'extract-products.log',
  'enrich-products': 'enrich-products.log',
  'secondhand-price-lookup': 'secondhand-price-lookup.log',
  'retail-price-lookup': 'retail-price-lookup.log',
  'enrich-listing-prices': 'enrich-listing-prices.log',
}
```

**Path resolution:** `server/index.ts`'s own `main()` runs with CWD set to
`server/` (its `.env` is loaded relative to CWD — see the comment there), so
a CWD-relative `data/<file>` would resolve to `server/data/<file>`, the
wrong place. The log files live in the repo-root `data/` dir (same one every
worker script writes to, since workers are run from repo root). Resolve the
path from the module's own location instead of CWD:
`path.join(fileURLToPath(new URL('.', import.meta.url)), '../../data', WORKER_LOG_FILES[worker])`
(`server/routes/logs.ts` → `..` = `server/` → `../..` = repo root → `data/<file>`).

**Read behavior:**
- `offset` omitted: read the **whole file**, return the last 200 lines and
  `nextOffset` = the file's current byte size. (Known simplification: reads
  the whole file just to tail it. Today's logs are low-thousands of lines /
  low hundreds of KB — fine. If a log grows large enough for this to be
  slow, switch to reading only the last ~64KB chunk before splitting lines —
  not needed for v1.)
- `offset` given: read from that byte offset to current EOF only (no
  whole-file read). Split into lines, drop a trailing empty string from the
  final newline. `nextOffset` = file size after this read.
- File doesn't exist yet (worker never run): treat as empty — return
  `{ lines: [], nextOffset: 0 }`, not an error.
- `offset` greater than current file size (log file was deleted/rotated/
  truncated externally — not handled elsewhere in this codebase, just
  guarded here): reset to a full re-tail, same as the "offset omitted" case.

**Response:** `{ lines: string[], nextOffset: number }`, `200`.

**Auth:** none added here — `handleRequest` in `server/app.ts` already
Bearer-checks every route before it reaches the handler.

## Frontend

**Proxy route:** `dashboard/src/app/api/logs/route.ts`, `POST`, same shape
as `dashboard/src/app/api/refresh-job/route.ts`: reads
`REFRESH_SERVER_URL`/`REFRESH_API_KEY` from env, forwards the request body
to `${REFRESH_SERVER_URL}/logs` with the Bearer header, relays the JSON
response and status code back unchanged. Returns `503` if either env var is
unset (matching the existing proxy routes' behavior).

**Page:** `dashboard/src/app/admin/logs/page.tsx`, client component.
- Worker picker: 7 tabs (or a `<select>` — implementer's call, not
  load-bearing), one per key in `WORKER_LOG_FILES` above. Defaults to
  `collect`.
- Log pane: monospace, scrollable, one line per log line, auto-scrolls to
  bottom on new lines (unless the user has scrolled up — don't yank them
  back down mid-read).
- On worker switch: clear the pane, reset offset to `undefined`, fetch tail
  immediately (don't wait for the next poll tick).
- Poll loop: every 3s, `POST /api/logs` with `{ worker, offset: <last nextOffset> }`,
  append returned `lines`, update `offset`.
- No auth code in this page — already covered by `dashboard/src/proxy.ts`'s
  existing cookie gate (matcher excludes only `/login`, `/api/login`,
  `/robots.txt`; `/admin/logs` is not in that exclusion list, so it's
  already protected without any change).

## Testing

- `server/routes/logs.ts`: unit tests for the handler — offset omitted
  returns last-200 + correct `nextOffset`; offset given returns only the
  delta; unknown `worker` key returns `400`; missing file returns empty
  lines/`nextOffset: 0`; offset past EOF resets to full tail. Follow the
  existing `server/routes/refreshJob.test.ts` style (call the handler
  function directly, no real HTTP server).
- No new dashboard component tests planned — this repo's dashboard tests are
  sparse (`dashboard/src/lib/*.test.ts`, logic not components); matches
  existing convention, not a gap introduced here.

## Open questions

None — all resolved during design (same-VPS filesystem access, polling
transport, dedicated page, existing auth reused throughout).
