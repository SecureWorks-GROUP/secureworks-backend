# Edge Functions Reference

All in `supabase/functions/`. Deploy with:
```bash
/Users/marninstobbe/.local/bin/supabase functions deploy <name> [--no-verify-jwt] --project-ref kevgrhcjxspbxgovpmfl
```

## Functions

### ghl-webhook
- **Purpose**: Creates jobs from GHL form submissions, creates contact_matches for attribution
- **Deploy**: `--no-verify-jwt` NO (has own auth)
- **Trigger**: GHL form webhook

### ghl-proxy `--no-verify-jwt`
- **Purpose**: Secure proxy to GHL API + job sync + scope complete flow
- **Key actions**: `opportunities`, `search`, `contact`, `find_job`, `create_job`, `save_scope`, `load_job`, `link`, `list_media`, `get_upload_url`, `register_media`, `upload_photo`, `delete_media`, `get_profile`
- **`link` action** (scope complete): moves GHL stage → adds note → generates job number → creates Xero contact → pushes $ to GHL

### xero-sync
- **Purpose**: All Xero API interactions
- **Deploy**: NO --no-verify-jwt (service role key required)
- **Actions**:
  - `token_refresh` — refresh Xero OAuth token (pg_cron every 20 min)
  - `sync_invoices` — pull ACCREC + ACCPAY invoices, auto-link by SW reference
  - `sync_reports` — pull P&L reports
  - `sync_projects` — pull Xero Projects (per-job revenue/expenses)
  - `sync_tracking_pl` — pull P&L by business unit
  - `match_contacts` — fuzzy match GHL contacts to Xero contacts
  - `backfill_contacts` — legacy backfill
  - `backfill_invoices` — legacy backfill
  - `sync_purchase_orders` — pull POs from Xero
  - `sync_suppliers` — pull supplier contacts from Xero
  - `create_or_find_contact` (POST) — find/create Xero contact, link to job
  - `match_invoices_by_reference` — link invoices with SW refs to jobs
  - `backfill_xero_contacts` — batch create Xero contacts for active jobs (?limit=10)

### reporting-api `--no-verify-jwt`
- **Purpose**: All dashboard data aggregation
- **Actions**: `dashboard_summary`, `job_profitability`, `marketing_summary`, `trends`, `sales_breakdown`, `insights`, `match_invoices`, `debt_followup`, `ceo_report` (orchestrator — calls all others)

### send-quote
- **Purpose**: PDF quote distribution + client portal + GHL monetary value push
- **Deploy**: `--no-verify-jwt` REQUIRED. This function has mixed routes:
  internal send routes use in-handler `x-api-key` auth, while public quote
  links (`/view`, `/accept`, `/decline`) are protected by share tokens. If the
  Supabase gateway JWT gate is on, quote links and fencing `/send-runs` calls
  fail before the function code runs.

### google-ads-ingest
- **Purpose**: Receives daily Google Ads metrics from Apps Script
- **Deploy**: NO --no-verify-jwt

### daily-digest
- **Purpose**: Exception-based daily business health summary
- **Deploy**: NO --no-verify-jwt (called by pg_cron)

### ops-api `--no-verify-jwt`
- **Purpose**: Ops dashboard CRUD — scheduling, POs, WOs, pipeline, job detail, Xero push
- **Also**: Trade mobile endpoints (my_jobs, upload_photo, service_report)
- **Also**: AI/automation (morning_brief, scope_to_po, complete_and_invoice)
- **Canonical source**: `secureworks-site/supabase/functions/ops-api`
- **Deploy guard**: Do not deploy `ops-api` from `securedash` or any dashboard
  submodule/worktree. Stale dashboard copies previously omitted newer site
  actions, and stale site copies omitted dashboard actions such as
  `list_ops_notes`; either direction can overwrite the one live function.
- **Deploy command**: use `scripts/deploy-edge-function.sh ops-api` from the
  canonical release worktree. Do not run raw Supabase deploys from feature
  worktrees.

### ops-ai `--no-verify-jwt`
- **Purpose**: Claude AI assistant for dashboards
- **Uses**: claude-sonnet-4-6 with tool_use
- **Requires**: ANTHROPIC_API_KEY secret set in Supabase
