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

### PostgREST 1000-row limit
Supabase REST API returns max 1000 rows by default. MUST use `fetchAll()` helper with `.range()` pagination for any query that might return > 1000 rows.

### Xero FullyPaidOnDate format
Comes as `/Date(1234567890000+0000)/` — NOT a normal date string. MUST parse with `parseXeroDate()` before inserting into Postgres date column. Otherwise ALL PAID invoice upserts silently fail (no error, just doesn't insert).

### Xero token expires every 30 minutes
Custom Connection OAuth. pg_cron refreshes every 20 min. If you make manual Xero API calls, get a fresh token first via `getToken(sb)` in xero-sync.

### Edge Function WORKER_LIMIT
Supabase Edge Functions have compute limits. Heavy operations (backfills, bulk Xero API calls) MUST be batched. Use `?limit=10` pattern and call repeatedly.

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
