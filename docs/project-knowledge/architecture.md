# System Architecture

## Overview
SecureWorks WA — multi-division outdoor living construction (patios, fencing, decking, renovations).
Single-tenant system. All hardcoded to org_id `00000000-0000-0000-0000-000000000001`.

## Tech Stack
- **Frontend**: Vanilla HTML/JS dashboards (no framework)
- **Backend**: Supabase Edge Functions (Deno/TypeScript)
- **Database**: Supabase Postgres with RLS
- **Auth**: Supabase Auth (magic link)
- **CRM**: GoHighLevel (GHL) — sales pipeline, contacts, opportunities
- **Accounting**: Xero — invoices, P&L, projects, contacts
- **Ads**: Google Ads → custom ingest script
- **Hosting**: GitHub Pages (scoping tools), Supabase (API/DB)

## Three Views
1. **CEO Dashboard** (`dashboard/index.html` + `dashboard/ceo.html`) — Marnin. Revenue, margins, pipeline, marketing, customers.
2. **Ops Dashboard** (`dashboard/ops.html`) — Shaun. Scheduling, jobs, POs, WOs, calendar, crew utilisation.
3. **Trade App** (`dashboard/trade.html`) — Field installers. My Jobs, job detail, POs/receipts, service reports, GPS check-in. PWA.

## Data Flow
```
Google Ads → google-ads-ingest → google_ads_daily table
GHL Forms → ghl-webhook → jobs + contact_matches tables
GHL Pipeline → ghl-proxy (sync) → jobs table (status updates)
Scoping Tools → ghl-proxy (save_scope/link) → jobs.scope_json + Xero contact + job number
Xero → xero-sync → xero_invoices, xero_reports, xero_projects, suppliers tables
Dashboard → reporting-api → aggregated metrics from all tables
Ops → ops-api → scheduling, POs, WOs, job detail
AI Chat → ops-ai → Claude API with tool_use calling ops-api + reporting-api
```

## Supabase Project
- Project ID: `kevgrhcjxspbxgovpmfl`
- URL: `https://kevgrhcjxspbxgovpmfl.supabase.co`
- CLI path: `/Users/marninstobbe/.local/bin/supabase` (NOT npx)
- Deploy: `/Users/marninstobbe/.local/bin/supabase functions deploy <name> --project-ref kevgrhcjxspbxgovpmfl`
- Some functions need `--no-verify-jwt` flag (see edge-functions.md)

## Key IDs
- Default org: `00000000-0000-0000-0000-000000000001`
- Xero tracking category (Business Unit): `68b39e33-e803-4163-af8d-2e8955a1ce2a`
- GHL Sales Pipelines: Fencing `I9t8njpuR0Dm7B2NDcvI`, Patios `OGZLpPPVWVarN94HL6af`
- GHL Execution Pipelines: Fencing `fgV2mkFh6BD4gOZZx94y`, Patios `SxayUz0KRDlCUk58apCC`
- GHL Materials Pipeline: `SkgfC3nzTsOHqTSv9LNl`

## Scoping Tools (GitHub Pages)
- Patio: `https://marninms98-dotcom.github.io/patio/`
- Fencing: `https://marninms98-dotcom.github.io/fence-designer/`
- Shared code: `tools/shared/cloud.js` + `tools/shared/integration.js`
- ALL Supabase queries go through edge functions (RLS blocks direct client calls)
