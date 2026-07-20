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
- **Key actions**: `opportunities`, `search`, `lead_search`, `contact`, `find_job`, `create_job`, `save_scope`, `load_job`, `link`, `list_media`, `get_upload_url`, `register_media`, `upload_photo`, `delete_media`, `get_profile`, `create_contact_and_opportunity` (POST)
- **`link` action** (scope complete): moves GHL stage → adds note → generates job number → creates Xero contact → pushes $ to GHL
- **`lead_search` action** (GET, used by the fencing tool): contact-first lead
  lookup. Params: `q` (query), `pipeline` (`fencing` or `patio`),
  `max_contacts` (default 8, clamped 1-10). With `q`: searches GHL contacts,
  then looks up each contact's opportunities in parallel, filters to the
  requested pipeline, and cross-references Supabase jobs (org-scoped when called
  with a user JWT); if GHL knows nothing about the query it falls back to an
  org-scoped `jobs` search. Without `q`: browses the pipeline's recent
  opportunities (capped at 2 GHL pages). Returns
  `{ opportunities: Row[], _mode: 'contact_search' | 'recent_browse' }`. Every
  GHL call carries an AbortSignal timeout — a timeout returns 504 with code
  `ghl_timeout`, other GHL failures return 502 (`ghl_contacts_search_failed` /
  `ghl_browse_failed`). Kept separate from `search`, which patio + the agents
  rely on and is unchanged.
- **`create_contact_and_opportunity` action** (POST): creates/dedups a GHL
  contact and opens an opportunity in the pipeline for `body.toolType`. Pass
  optional `body.contactId` for the repeat-client path — dedup and contact
  creation are skipped, the contact is fetched to verify it exists (404 →
  `contact_not_found`), and a NEW opportunity is created with a name built from
  the fetched contact's identity. `body.skipOpportunity` suppresses opportunity
  creation on either path.

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
  internal send routes (`/send`, `/send-invoice`, `/send-runs`) accept either
  the master `SW_API_KEY`/service-role key (via `x-api-key` or
  `Authorization: Bearer`, server-to-server) **or** a logged-in Supabase user
  JWT — the bearer is verified with `auth.getUser` and any authenticated user is
  allowed (role is captured for attribution logging but not gated). This mirrors
  ops-api's api_key/jwt pattern and unblocks the scoping tools, which send the
  user's session JWT as the bearer. Public quote links (`/view`, `/accept`,
  `/decline`) are protected by share tokens. If the Supabase gateway JWT gate is
  on, quote links and fencing `/send-runs` calls fail before the function code
  runs.

### google-ads-ingest
- **Purpose**: Receives daily Google Ads metrics from Apps Script
- **Deploy**: NO --no-verify-jwt

### daily-digest
- **Purpose**: Exception-based daily business health summary
- **Deploy**: NO --no-verify-jwt (called by pg_cron)
- **Actions**: no `action` param (full digest), `weekly_pulse`, `ceo_financial_brief`,
  `financial_snapshot`, `stale_followup`
- **Retired actions**: `nudge_check`, `eod_followup`, `shaun_brief` were message-delivery
  handlers, removed 2026-07-20. They now return 410 with `{ error: "Retired action: ..." }`,
  and their pg_cron schedules were unscheduled by
  `20260720000003_remove_retired_messaging_crons.sql`. Do not re-add callers.

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
