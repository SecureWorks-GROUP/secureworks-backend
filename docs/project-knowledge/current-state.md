# Current System State (as of 3 March 2026)

## Data Health
| Metric | Value | Notes |
|--------|-------|-------|
| Total jobs | 1,221 | 1000 sales + 221 execution pipelines |
| Contact match rate | 65% (357/548) | Was 22% before sync layer |
| Jobs → Xero contact | 337/1,221 | New capability from backfill |
| Invoices → Jobs | 316 linked | Via contact_id and reference matching |
| Xero Projects matched | 108/171 | Real per-job P&L data |
| Total ACCREC invoices | 305 | Sales invoices |
| Total ACCPAY invoices | ~731 | Bills/expenses |
| Win rate | 54% | 188/349 quoted |
| CPA | $28 | Cost per acquisition |
| PPAD | $174.57 | Profit per ad dollar |

## Revenue (Feb 2026 — fallback, March just started)
| Type | Revenue |
|------|---------|
| Patios | $43,176 |
| Fencing | $41,560 |
| Renovations | $10,620 |
| Other | $13,960 |
| **Total** | **$109,316** |
| Margin | 20% (target 30%) |

## Customer Metrics (newly enabled)
| Metric | Value |
|--------|-------|
| Avg CLV | $4,615 |
| Total customers | 133 |
| Total tracked revenue | $614K |
| Repeat rate | 59% |
| Top 5 concentration | 33% (healthy) |
| Top customer | Brett & Steph Hunt ($96K) |

## AR / Collections
| Bucket | Amount | Count |
|--------|--------|-------|
| Current | $1,215 | 2 |
| 1-30 days | $24,612 | 13 |
| 31-60 days | $11,178 | 6 |
| 61-90 days | $11,779 | 4 |
| 90+ days | $19,256 | 20 |
| **Total** | **$68,038** | **45** |
| DSO | 28 days (target 30) | |

## Pipeline (updated 3 March — after legacy cleanup)
| Status | Count | Notes |
|--------|-------|-------|
| accepted | 15 | |
| scheduled | 10 | |
| in_progress | 16 | |
| complete | 0 | Was 137, bulk-moved to invoiced (see below) |
| invoiced | 147 | Was 10, +137 from legacy cleanup |

| Metric | Value |
|--------|-------|
| Raw pipeline | $481,528 |
| Weighted pipeline | $220,815 |
| Coverage | 4.4x (target 2.0x) |

## Dashboard Views
| View | URL/File | Auth | Status |
|------|----------|------|--------|
| CEO Dashboard | dashboard/index.html | Supabase magic link | Working |
| CEO Report | dashboard/ceo.html | No auth (public) | Working — Customers section re-enabled |
| Ops Dashboard | dashboard/ops.html | Supabase magic link | Working |
| Trade App | dashboard/trade.html | Supabase magic link (JWT) | Built — PWA, 3 tabs, receipts, GPS, signatures |

## Edge Functions — Deploy Flags

Production `ops-api` and `send-quote` deploys must only run from
`secureworks-site/main` or
`/Users/marninstobbe/Projects/_release/secureworks-site-main` using
`scripts/deploy-edge-function.sh`. See `EDGE_DEPLOY_LANE.md`.

| Function | --no-verify-jwt | Notes |
|----------|-----------------|-------|
| ghl-proxy | YES | Scoping tools call without auth |
| ghl-webhook | NO | Has its own auth check |
| reporting-api | YES | CEO report loads without login |
| ops-api | YES | Ops dashboard needs it |
| ops-ai | YES | AI chat endpoints |
| xero-sync | NO | Service role key required |
| send-quote | YES | Mixed public token routes + internal x-api-key routes; gateway JWT must stay off |
| google-ads-ingest | NO | Script sends API key |
| daily-digest | NO | Called by pg_cron with service key |

## pg_cron Schedules (active)
| Job | Schedule | Action |
|-----|----------|--------|
| Xero token refresh | Every 20 min | token_refresh |
| Invoice sync | Every 2 hours | sync_invoices |
| Report sync | Daily 2am UTC | sync_reports |
| Contact matching | Daily 3am UTC | match_contacts |
| Project sync | Daily 4am UTC | sync_projects |
| Tracking P&L | Daily 4:30am UTC | sync_tracking_pl |
| PO sync | Every 30 min (XX:05/35) | sync_purchase_orders |
| Supplier sync | Daily 9pm UTC (5am AWST) | sync_suppliers |
| Daily digest | Daily 11pm UTC (7am AWST) | daily_digest |

## What's Working vs Not
### Working
- Job number generation (SWP/SWF/SWD etc)
- Xero contact find by email (no duplicates)
- Reference-based invoice matching (wired in)
- Contact backfill (complete)
- Dashboard metrics including CLV/concentration
- Invoice sync with auto-reference matching
- GHL pipeline sync (sales + execution)
- Xero P&L reports by business unit
- Google Ads ingest and marketing metrics

### Known Issues
- Name-only Xero matching is exact (email is reliable path)
- Channel attribution mostly "Unknown/Unattributed"
- Margin at 20% vs 30% target (business issue not data)
- $19K in 90+ day overdue AR
- Xero Projects expense data understated (bookkeepers not linking receipts)
- 12 jobs have phone numbers as client names (unfixable GHL data)
- Live scope complete flow not yet tested with real scope (code deployed)
- **site_suburb and site_address are NULL on 100% of jobs** — GHL sync doesn't pull address fields
- **scope_json is empty on all jobs** — scope-to-PO extraction has no data to work with yet
- **pricing_json only has totals** (source:ghl + totalExGST/totalIncGST) — no line items, so cascade invoice creates single-line invoices

### Data Cleanup Log
- **3 March 2026**: Bulk-moved 137 legacy "complete" jobs to "invoiced". These were old GHL pipeline imports (pre-ops dashboard) with no assignments, no POs, no WOs, no SW job numbers. They were already invoiced through Tradify/old Xero org. `complete` count went from 137 → 0, `invoiced` went from 10 → 147.

### Not Built Yet
- Auto Xero draft quote at scope complete
- Quote vs Invoice analysis dashboard
- Pipeline Velocity metrics (GHL doesn't set timestamps)
- Address backfill (site_suburb/site_address NULL on all jobs)
