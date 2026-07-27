# Gotchas & Lessons Learned

## CRITICAL — Will Break Things If Ignored

### ops-api and send-quote have one production deploy lane
Production `ops-api` and `send-quote` deploys are allowed only from
`SecureWorks-GROUP/secureworks-site/main` or the local release worktree:
`/Users/marninstobbe/Projects/_release/secureworks-site-main`.

Do not deploy these functions from dashboard repos, stale worktrees, feature
folders, copied repos, or `/private/tmp`. There is one live Supabase function
slug and the last deploy wins. A stale deploy can remove actions used by Ops,
Sales, Finance, Evidence, Scope Freeze, or quote sending.

Use `scripts/deploy-edge-function.sh ops-api` and
`scripts/deploy-edge-function.sh send-quote`. See
`docs/project-knowledge/EDGE_DEPLOY_LANE.md`.

### Supabase PostgrestFilterBuilder has no .catch()
`sb.from('table').insert({...}).catch(() => {})` will CRASH with "catch is not a function".
**Fix**: Use `try { await sb.from('table').insert({...}) } catch (_) { }` instead.

### A wrong column name returns zero rows, not an error
PostgREST rejects a select naming a non-existent column with a 400 (`42703`): `data` is null and `error` is set. Call sites that destructure `{ data }` only degrade silently to zero rows — a $0 pipeline figure, an empty digest, or an unmatched invoice reads exactly like a quiet week. Several of these survived for months.

**Fix pattern**: verify names against `information_schema.columns` (not the migrations); alias in the select to keep the response shape (`select('date:invoice_date')`) but use the REAL name in `.eq()`/`.gte()`/`.order()`; and check `error` on any read whose emptiness is business-meaningful — `logQueryErrors()` in `_shared/pgrest.ts` labels a `Promise.all` batch. Live names that commonly surprise are listed in `database-schema.md` and `AGENTS.md`.

### Apply migrations before deploying edge functions
Migrations and edge deploys are separate manual steps. Follow the authoritative
production guard and deployment sequence in
`docs/project-knowledge/EDGE_DEPLOY_LANE.md`; its manifest is
`scripts/edge-function-schema-requirements.txt`. Deploying a function that
selects a column the migration has not added can report zero instead of failing.
The current `jobs.quoted_value` (`20260717000001`) case affects the four
`daily-digest` reads; `ops-api` derives its response value from `pricing_json`,
and `reporting-api` derives its `quoted_value` response key from the same source.

### PostgREST 1000-row limit
Supabase REST API returns max 1000 rows by default. MUST use `fetchAll()` helper with `.range()` pagination for any query that might return > 1000 rows.

**A paginated read must also end on a UNIQUE sort key.** `.range()` is LIMIT/OFFSET, and Postgres guarantees no ordering between two separate LIMIT/OFFSET queries unless the `ORDER BY` is a *total* order. Order by a non-unique column alone (a date, `job_id`, `created_at`) and a row tied on that column can come back on neither page — it reads as absent, not as an error: a filed work order shows as missing, a sent pack re-surfaces as unsent. `fetchAllRows` / `fetchAllRowsInChunks` in `supabase/functions/ops-api/makesafe_compact_reads.ts` require a unique page-order key and append it after any caller-supplied primary sort; `_fetchAllByJobIdChunked` in `ops-api/index.ts` passes the table PK through the same reader. Prefer the stable primary key (`id`, or `post_id` on `emails`). Allocated-trade restrict lists use the same `chunkByUrlBudget` / `IN_URL_BUDGET` contract so a large `.in('id', …)` cannot exceed the gateway URL limit. Guards: unique page-tie-breaker tests in `makesafe_audit_test.ts`, PAGE-1 hostile >1000-row tied-key tests in `makesafe_compact_reads_test.ts`, and F7 multi-chunk restrict tests in `makesafe_pagination_test.ts`.

### Xero FullyPaidOnDate format
Comes as `/Date(1234567890000+0000)/` — NOT a normal date string. MUST parse with `parseXeroDate()` before inserting into Postgres date column. Otherwise ALL PAID invoice upserts silently fail (no error, just doesn't insert).

### Xero token expires every 30 minutes
Custom Connection OAuth. pg_cron refreshes every 20 min. If you make manual Xero API calls, get a fresh token first via `getToken(sb)` in xero-sync.

### Edge Function WORKER_LIMIT
Supabase Edge Functions have compute limits. Heavy operations (backfills, bulk Xero API calls) MUST be batched. Use `?limit=10` pattern and call repeatedly.

### Never select scope_json in a query that returns many rows
`jobs.scope_json` (and therefore the `calendar_events` view) is NOT a small config blob — it averages ~100 kB per row and peaks at 2.6 MB, because the scoping tools park base64 media under `scope_json.job.sitePlanImage` and `.checklist`.

This killed the Ops calendar: `ops-api?action=calendar` selected the whole blob just to derive the readiness badges, then stripped it from the response. A 9-month window pulled 115 MB into the worker for 157 kB of actually-used keys, and the worker was OOM-killed — surfacing as **HTTP 546**. Narrow windows returned 200, which is why it looked like an infra problem.

**Fix pattern**: single-job reads (`job_detail`, invoicing, scope-to-PO) may select the blob. Any query returning many rows must project only the keys it needs via PostgREST jsonb projection (`select=alias:scope_json->job->someKey`). PostgREST cannot strip keys, and `::text` casts are not honoured in filters — only projection bounds the payload. `calendarEvents()` does this with `CAL_SCOPE_PROJECTION`. `ops_summary`'s `today_schedule` enumerates the 13 `calendar_events` columns it emits (`OPS_SUMMARY_SCHEDULE_COLUMNS`) for the same reason. Full rules, including the `include_financials` column-enumeration tradeoff, are in `AGENTS.md`.

The same applies to `jobs.pricing_json`: `ops-api?action=pipeline` projects the four JSON paths it needs (`PIPELINE_PRICING_PROJECTION`) instead of pulling the quote blob for every active job. Use `->` not `->>` there — `->>` returns text and would turn numeric totals into strings. See `AGENTS.md` for the malformed-blob fallback probe that covers double-encoded `pricing_json` rows.

### Supabase CLI path
`/Users/marninstobbe/.local/bin/supabase` — NOT available via `npx` or global PATH.

### Duplicate const declarations
Same `const` variable name in the same function scope causes Deno BOOT_ERROR. The function won't even start — no useful error message.

### --no-verify-jwt on deploy
Some functions MUST be deployed with `--no-verify-jwt` or they'll return 401:
- ghl-proxy, reporting-api, ops-api, ops-ai, send-quote
If you redeploy without the flag, the dashboard/scoping tools break with 401 errors.

## DATA QUALITY

### GHL data is messy
- 12 jobs have phone numbers as client_name (can't create Xero contacts for these)
- Duplicate opportunities exist
- Stages not always updated correctly
- `quoted_at` and `accepted_at` timestamps rarely set (Pipeline Velocity metrics broken)

### Xero name matching is exact
`create_or_find_contact` searches by email first (reliable), then exact name. "Brett Hunt" won't match "Brett and Steph Hunt". Client email from scoping tool is the reliable path to avoid duplicates.

### Xero Projects expense data is low quality
Bookkeepers aren't consistently linking receipts to Xero Projects. Job-level cost data is understated. PO integration planned to improve this.

### Job number sequence consumed on tests
SWP-25000 through SWF-25003 were used during testing. Next real job number will be 25004+. Not a problem, just a gap in the sequence.

### Legacy GHL imports look like active jobs
137 jobs synced from GHL execution pipelines came in as status `complete` but were already invoiced through Tradify. They had zero ops activity (no assignments, no POs, no WOs, no SW job numbers). Bulk-moved to `invoiced` on 3 March 2026. If you see a spike of "complete not invoiced" jobs again, check if they're legacy imports before panicking.

### Attention items need job_ids for Feature 3
The `renderAttention()` function in ops.html uses `item.job_ids[0]` to open modals. If an attention item doesn't include `job_ids` or `items` with `.id`, the click-to-action won't work. Always include `job_ids` when adding new attention types in ops-api `opsSummary()`.

### site_suburb and site_address are NULL everywhere
GHL sync doesn't pull address fields into jobs. Any feature that depends on location data (crew utilization by area, suburb-based routing, AI "what jobs in Hillarys?") will return nothing until address backfill is done.

### ops-ai requires ANTHROPIC_API_KEY secret
AI chat and morning brief won't work until the key is set: `/Users/marninstobbe/.local/bin/supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`. The function returns a clear error message if missing.

## TRADE APP GOTCHAS

### ops-api has both Ops and Trade endpoints — collision risk
Both the Ops and Trade Claude instances edit `supabase/functions/ops-api/index.ts`. The file is ~2,100 lines:
- Lines 1-320: Router + shared helpers
- Lines 323-1500: Ops dashboard endpoints
- Lines 1504-1990: Trade endpoints (my_jobs, upload_photo, service_report, etc.)
- Lines 1990+: Shared utilities
If both instances deploy at the same time, the last deploy wins. Coordinate deploys.

### authTrade returns Supabase auth user ID (same as users.id)
`users.id references auth.users(id)` — they're the same UUID. The JWT `user.id` matches the `users` table `id`. Don't create a separate auth_id mapping.

### cloud.js onAuthStateChange only handles SIGNED_IN
The handler at cloud.js line 201 only catches `event === 'SIGNED_IN'`. Supabase v2 fires `INITIAL_SESSION` for existing sessions on page load. This means: if a user is logged in from CEO/Ops dashboard and opens trade.html, their existing session might not trigger the login flow. They may need to re-authenticate. Fix: handle `INITIAL_SESSION` in cloud.js (affects all dashboards).

### job_assignments.role constraint
Valid values: `lead_installer`, `helper`, `estimator`. Using `lead` or `installer` will fail with a constraint violation. Check migration 001 line 166.

### PO line items have inconsistent keys
Xero-synced POs have line items with keys like `Description`, `Quantity` (Pascal case). Locally created POs use `description`, `quantity` (camel case). The trade detail view handles both: `li.description || li.Description`. Always check both casings.

### Trade photo uploads use signed URL flow (not base64)
The `uploadPhoto` endpoint (base64 dataUrl) exists but the frontend uses the 3-step flow for better reliability on mobile:
1. `get_upload_url` → signed URL
2. `PUT` binary to storage URL
3. `confirm_upload` → registers media record
The `confirm_upload` step accepts `po_id` and `phase: 'receipt'` for receipt photos.

### Service worker cache must be bumped on every trade.html change
`sw-trade.js` has `CACHE_NAME = 'sw-trade-v3'`. If you change trade.html, bump this version or users on mobile will see stale cached version until the SW updates in background.

## PATTERNS TO FOLLOW

### Non-blocking sync calls
All Xero/GHL API calls in the scope complete flow (ghl-proxy `link`) are wrapped in try/catch. If Xero or GHL is down, the scope still completes successfully. Never make external API calls blocking for the user.

### Rate limiting for Xero
60 requests/minute limit. Backfill functions pause every 5 jobs (`await new Promise(r => setTimeout(r, 3000))`). The `xeroGet` and `xeroPost` helpers auto-retry on 429 with Retry-After header.

### Service role for all queries
RLS policies block most client-side queries. Edge functions use service role key for all Supabase queries. The scoping tools route ALL queries through edge functions.
