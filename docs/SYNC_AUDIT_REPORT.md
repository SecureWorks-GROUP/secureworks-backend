# SecureWorks WA — Data Sync Pipeline Audit Report

**Date:** 4 March 2026
**Scope:** All data sync pipelines (GHL, Xero, Google Ads) + CEO Dashboard accuracy
**Out of scope:** Ops Dashboard, Trade App, Scoping Tools

---

## Executive Summary

Audited 5 edge functions, 15 database migrations, 9 pg_cron schedules, and the CEO Dashboard data rendering. Found **5 bugs**, all fixed. One additional minor fix applied to reporting-api for dashboard data quality display.

**Impact of fixes:**
- Site addresses will now populate on all jobs (was NULL on all 1,221 jobs)
- Contact match rate should improve beyond 65% (phone matching added)
- Xero contact creation is now reliable (broken upsert fixed)
- Job queries no longer filter on non-existent `'won'` status

---

## Sync Pipelines

### 1. GHL → Supabase (ghl-webhook)

**Function:** `supabase/functions/ghl-webhook/index.ts` (253 lines)
**Trigger:** HTTP POST from GHL form submissions
**Purpose:** Creates draft jobs + contact_matches for attribution tracking

| Check | Status | Notes |
|-------|--------|-------|
| Field mapping | Fixed | Was missing `address1` (GHL's field name) |
| Duplicate detection | OK | Checks `ghl_contact_id` before creating |
| Contact attribution | OK | Lead source detection: gclid → utm_source → body.source |
| Error handling | OK | Try/catch with JSON error response |

**Bug found & fixed:**
- `site_address` field lookup missing `address1` and `streetAddress` — GHL contacts use `address1` not `address`

---

### 2. GHL → Supabase (ghl-proxy / sync_ghl)

**Function:** `supabase/functions/ghl-proxy/index.ts` (963 lines)
**Trigger:** pg_cron (not scheduled — manual or on-demand) + scoping tool actions
**Purpose:** Bulk syncs ALL GHL opportunities from 4 pipelines into jobs table

| Check | Status | Notes |
|-------|--------|-------|
| Pipeline coverage | OK | Sales (patios + fencing) + Execution (patios + fencing) |
| Stage mapping | OK | 17 GHL stages → 8 Supabase statuses via STAGE_MAP |
| Contact creation | Fixed | Was never extracting address from GHL contact |
| Job number generation | OK | Uses `next_job_number()` RPC |
| Xero contact creation | Fixed | Broken upsert replaced with find-then-update pattern |
| Dedup logic | OK | Matches on `ghl_opportunity_id` |

**Bugs found & fixed:**
1. **Site addresses always NULL** — `sync_ghl` never extracted `opp.contact?.address1` or `opp.contact?.city`. Now extracts and passes to both new job creation and existing job updates (backfill).
2. **`createOrFindContact` upsert broken** — Used `onConflict: 'org_id,job_id'` but no such unique constraint exists on `contact_matches`. Replaced with explicit find-by-job_id → find-by-ghl_contact_id → update-or-insert.

---

### 3. Xero → Supabase (xero-sync)

**Function:** `supabase/functions/xero-sync/index.ts` (1,746 lines)
**Trigger:** 6 pg_cron schedules (token refresh, invoices, reports, projects, tracking P&L, POs)
**Purpose:** All Xero API interactions — invoices, P&L, contacts, projects, purchase orders

| Check | Status | Notes |
|-------|--------|-------|
| Token refresh | OK | Client credentials grant, 30-min expiry, refreshed every 20 min |
| Invoice sync | OK | Incremental via If-Modified-Since, handles pagination |
| P&L reports | OK | Current, previous month, YTD, aged receivables |
| Tracking P&L | OK | 12-month P&L by tracking category (business unit) |
| Contact matching | Fixed | Was missing phone matching |
| Backfill query | Fixed | Used invalid status `'won'` |
| Xero date parsing | OK | `/Date(ms)/` format handled correctly |
| Rate limiting | OK | Retry-after header respected |
| Projects sync | OK | Maps to xero_projects table |
| PO sync | OK | Maps to purchase_orders table |

**Bugs found & fixed:**
1. **Contact matching missing phone** — Only matched email → name → surname+initial. Added AU phone normalization (`+614` → `04`, strip spaces/dashes) and phone matching pass between email and name. Should improve the 65% match rate.
2. **Invalid status `'won'`** — `backfillXeroContacts` filtered `.in('status', ['won', 'complete', ...])` but `'won'` doesn't exist in the status enum. Silently excluded — removed from both occurrences.

---

### 4. Google Ads → Supabase (google-ads-ingest)

**Function:** `supabase/functions/google-ads-ingest/index.ts` (158 lines)
**Trigger:** Google Apps Script (daily push)
**Purpose:** Receives daily metrics, keywords, and landing page data

| Check | Status | Notes |
|-------|--------|-------|
| Data ingestion | OK | 3 data types in single POST |
| Cost conversion | OK | Dollars → cost_micros (×1,000,000) |
| Auth | OK | X-API-Key or Bearer token |
| Upsert logic | OK | Conflict on (org_id, campaign_id, report_date) |
| Keywords table | OK | Conflict on (org_id, keyword_text, match_type, campaign_id, ad_group_id) |
| Landing pages | OK | Conflict on (org_id, url, report_date) |

**No bugs found.**

---

### 5. Job Number System

**Function:** `next_job_number()` SQL function + `job_number_seq` sequence
**Trigger:** Called from `ghl-proxy` link action

| Check | Status | Notes |
|-------|--------|-------|
| Sequence | OK | Starts at 25000, increments by 1 |
| Prefix mapping | OK | patio→SWP, fencing→SWF, decking→SWD, renovation→SWR, insurance→SWI |
| Uniqueness | OK | Unique constraint on `(org_id, job_number)` |
| Format | OK | e.g., `SWP-25001` |

**No bugs found.**

---

## pg_cron Schedules

All 9 schedules verified across 4 migration files:

| Schedule | Frequency | Function | Action | Status |
|----------|-----------|----------|--------|--------|
| xero-token-refresh | Every 20 min | xero-sync | token_refresh | OK |
| xero-invoice-sync | Every 15 min | xero-sync | sync_invoices | OK |
| xero-reports-sync | 10:00 PM daily | xero-sync | sync_reports | OK |
| contact-matching | 7:00 PM daily | xero-sync | match_contacts | OK |
| xero-projects-sync | 10:15 PM daily | xero-sync | sync_projects | OK |
| xero-tracking-pl-sync | 10:30 PM daily | xero-sync | sync_tracking_pl | OK |
| xero-po-sync | Every 30 min | xero-sync | sync_purchase_orders | OK |
| xero-supplier-sync | 9:00 PM daily | xero-sync | sync_suppliers | OK |
| daily-digest | 11:00 PM daily (7 AM AWST) | daily-digest | — | OK |

All schedules use Vault-based auth headers. Times are UTC (add 8 hours for AWST).

---

## CEO Dashboard Accuracy

### Data Flow Verification

The CEO Dashboard (`dashboard/index.html`, ~5,400 lines) calls `reporting-api` via `reportingFetch()`. All 7 API actions verified:

| API Action | Dashboard Rendering | Match | Notes |
|------------|-------------------|-------|-------|
| `dashboard_summary` | Revenue, margin, pipeline, AR aging, forecasts, break-even, targets, stacked revenue, type breakdown | Perfect | All 11 data groups consumed correctly |
| `insights` | KPI scorecard, actionable insights, data quality status | Fixed | Added missing `invoices_synced` to `data_quality` |
| `marketing_summary` | Ad spend, CPL, CPA, ROAS, funnel, daily chart, campaigns, keywords, landing pages | Perfect | `daily_data` field confirmed present |
| `trends` | 12-month charts for margin, cash flow, win rate, deal size, ads | Perfect | All arrays consumed |
| `sales_breakdown` | Revenue by type (dual bar: Xero + pipeline) | Good | Suburbs/velocity/accuracy built but not rendered (future) |
| `job_profitability` | Job P&L table, scatter plot, summary stats | Perfect | All fields consumed |
| `debt_followup` | Client cards with invoice breakdown, contact info | Perfect | All fields consumed |

### CEO Report Page

`dashboard/ceo.html` (~1,876 lines) uses `ceo_report` action which orchestrates all 12 sub-queries in parallel:
- `dashboardSummary`, `trends`, `salesBreakdown`, `marketingSummary`, `generateInsights`, `debtFollowup`, `customerLTV`, `costAnalysis`, `cashForecast`, `budgetBurn`, `problemJobs`, `syncHealth`

Customer metrics (CLV, repeat rate, concentration) are correctly rendered from `customerLTV` response.

### Fix Applied

**`invoices_synced` missing from data_quality** — Dashboard line 5372 expected `data_quality.invoices_synced` but `generateInsights` didn't return it. Added an invoice count query to the parallel fetch and included it in the return object.

---

## Summary of All Fixes

| # | File | Bug | Fix | Impact |
|---|------|-----|-----|--------|
| 1 | ghl-proxy/index.ts | `sync_ghl` never extracted address from GHL contacts | Added `opp.contact?.address1` and `opp.contact?.city` extraction + backfill for existing jobs | All 1,221 jobs had NULL addresses |
| 2 | ghl-webhook/index.ts | Address field lookup missing `address1` (GHL's actual field name) | Added `address1` and `streetAddress` to `find()` keys | New webhook leads had NULL addresses |
| 3 | xero-sync/index.ts | Contact matching only used email + name, ignored phone numbers | Added AU phone normalization + phone matching pass | ~35% unmatched contacts may now match |
| 4 | xero-sync/index.ts | `backfillXeroContacts` filtered on non-existent `'won'` status | Removed `'won'` from `.in()` filter (2 occurrences) | Silent filter mismatch |
| 5 | ghl-proxy/index.ts | `createOrFindContact` upsert used wrong conflict target `(org_id, job_id)` — no such constraint exists | Replaced with find-then-update-or-insert pattern | Could create duplicate contact_matches or silently fail |
| 6 | reporting-api/index.ts | `data_quality` missing `invoices_synced` field expected by dashboard | Added invoice count query + field to return object | Dashboard showed `undefined invoices synced` |

---

## Deployment Required

None of the fixes have been deployed yet. Deploy in this order:

```bash
# 1. ghl-proxy (address extraction + contact matching fix)
/Users/marninstobbe/.local/bin/supabase functions deploy ghl-proxy --project-ref kevgrhcjxspbxgovpmfl --no-verify-jwt

# 2. ghl-webhook (address field mapping fix)
/Users/marninstobbe/.local/bin/supabase functions deploy ghl-webhook --project-ref kevgrhcjxspbxgovpmfl

# 3. xero-sync (phone matching + status filter fix)
/Users/marninstobbe/.local/bin/supabase functions deploy xero-sync --project-ref kevgrhcjxspbxgovpmfl

# 4. reporting-api (invoices_synced data quality fix)
/Users/marninstobbe/.local/bin/supabase functions deploy reporting-api --project-ref kevgrhcjxspbxgovpmfl --no-verify-jwt
```

---

## Post-Deploy Actions

After deploying, run these to backfill data:

1. **Backfill addresses** — Trigger `sync_ghl` to pull addresses from GHL contacts into existing jobs:
   ```
   POST /functions/v1/ghl-proxy
   { "action": "sync_ghl" }
   ```

2. **Re-run contact matching** — Phone matching will attempt to match the ~35% unmatched contacts:
   ```
   POST /functions/v1/xero-sync
   { "action": "match_contacts" }
   ```

3. **Re-run invoice matching** — With improved contact matches, more invoices can be linked to jobs:
   ```
   POST /functions/v1/reporting-api
   { "action": "match_invoices" }
   ```

---

## Remaining Issues (Manual Intervention)

| Issue | Action Required | Priority |
|-------|----------------|----------|
| Xero token expiry | Verify Xero Custom Connection is active and `token_refresh` cron is running. If tokens fail, re-authorize in Xero developer portal. | High |
| GHL webhook URL | Verify GHL form webhook points to `https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ghl-webhook` and `GHL_WEBHOOK_SECRET` env var is set. | Medium |
| Google Ads Apps Script | Verify the daily push script is running and `GOOGLE_ADS_INGEST_KEY` env var matches. | Medium |
| Invoice-to-job match rate | Currently ~11% — depends on contact match rate improving. After phone matching backfill, re-run `match_invoices`. | Low |
| `sync_ghl` not scheduled | Unlike Xero syncs, GHL sync has no pg_cron schedule. Consider adding a daily or hourly cron. | Low |

---

## Recommended Improvements

1. **Schedule `sync_ghl`** — Add a pg_cron job to run `sync_ghl` every 30-60 minutes so jobs stay in sync with GHL without manual triggers.

2. **Add GCLID-based attribution** — The `contact_matches` table has `gclid` but GCLID→job attribution is sparse. Consider adding GCLID capture to GHL form hidden fields and passing through the webhook.

3. **Xero webhook** — Currently polling every 15 min. Xero supports webhooks for real-time invoice updates which would improve data freshness.

4. **Per-job P&L from Xero Projects** — `xero_projects` already syncs but the invoice-to-job match rate limits per-job profitability. The tracking P&L (by business unit) is a better source until match rates improve.

5. **Dashboard suburbs/velocity/accuracy** — `sales_breakdown` already returns `by_suburb`, `pipeline_velocity`, and `quote_accuracy` data. The dashboard has placeholders for these — consider rendering them.
